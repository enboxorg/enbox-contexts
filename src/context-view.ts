import type { RecordView, RecordViewState } from './host-types.js';
import type { ObservableStore } from './observed-view.js';

import { ObservedView, openView } from './observed-view.js';

const MEMBER_ROOT_OPEN_CONCURRENCY = 4;

/** A saved follow choice, including contexts whose access cannot currently be restored. */
export type SavedContextFollow = Readonly<{
  key: string;
  id: string;
  ownerDid: string;
  /** Module path of the saved context root. */
  path: string;
}>;

/** Immutable state of one module's local context catalog. */
export type ContextViewState<Context> = Readonly<{
  contexts: readonly Context[];
  /** Current saved follow entries in key order; a saved entry alone does not establish access. */
  savedFollows: readonly SavedContextFollow[];
}> & Readonly<
  | { status: 'loading'; error?: never }
  | { status: 'ready'; error?: never }
  | { status: 'error'; error: Error }
>;

type ReadyContextViewState<Context> = Extract<ContextViewState<Context>, { status: 'ready' }>;

/** Closeable live view of one module's local context catalog. */
export interface ContextView<Context> extends ObservableStore<ContextViewState<Context>> {
  ready(options?: Readonly<{ signal?: AbortSignal }>): Promise<ReadyContextViewState<Context>>;
  close(): Promise<void>;
}

/** One accepted member context paired with its independently observed root state. */
export type MaterializedMemberContext<Context, Root> = Readonly<{
  context: Context;
  root: RecordViewState<Root>;
}>;

export type ContextViewOptions<Context> = {
  callerSignal?: AbortSignal;
  getSavedFollows?(): readonly SavedContextFollow[];
  list(): Promise<readonly Context[]>;
  openWakeSubscription(
    wake: () => void,
    fail: (error: Error) => void,
  ): Promise<{ close(): Promise<void> }>;
  signal?: AbortSignal;
};

export type MaterializedMemberContextViewOptions<Context extends { key: string }, Root> = {
  callerSignal?: AbortSignal;
  getSavedFollows?(): readonly SavedContextFollow[];
  listContexts(): Promise<readonly Context[]>;
  openRootView(context: Context, signal: AbortSignal): Promise<RecordView<Root>>;
  openWakeSubscription(
    wake: () => void,
    fail: (error: Error) => void,
  ): Promise<{ close(): Promise<void> }>;
  signal?: AbortSignal;
};

export async function createContextView<Context>(
  options: ContextViewOptions<Context>,
): Promise<ContextView<Context>> {
  options.callerSignal?.throwIfAborted();
  options.signal?.throwIfAborted();
  const view = new ObservedContextView(options);
  await openView(view, [options.callerSignal, options.signal]);
  return view;
}

class ObservedContextView<Context> extends ObservedView<ContextViewState<Context>> implements ContextView<Context> {
  private readonly _getSavedFollows: () => readonly SavedContextFollow[];
  private readonly _list: ContextViewOptions<Context>['list'];
  private readonly _openWakeSubscription: ContextViewOptions<Context>['openWakeSubscription'];
  private _wakeSubscription?: { close(): Promise<void> };

  public constructor(options: ContextViewOptions<Context>) {
    super(immutableState({ status: 'loading', contexts: [], savedFollows: [] }), options.callerSignal, options.signal);
    this._getSavedFollows = options.getSavedFollows ?? ((): readonly SavedContextFollow[] => []);
    this._list = options.list;
    this._openWakeSubscription = options.openWakeSubscription;
  }

  public async open(): Promise<void> {
    try {
      const wakeSubscription = await this._openWakeSubscription(
        (): void => {
          if (this._wakeSubscription !== undefined) {
            this.requestMaterialization();
          }
        },
        (error): void => {
          if (!this.isClosed) {
            this.publishError(error);
            void this.close().catch((): void => {});
          }
        },
      );
      if (this.isClosed) {
        await wakeSubscription.close();
        this._callerSignal?.throwIfAborted();
        this._sessionSignal?.throwIfAborted();
        return;
      }
      this._wakeSubscription = wakeSubscription;
      this.requestMaterialization();
    } catch (error: unknown) {
      await this.close();
      throw error;
    }
  }

  protected async closeOwnedResources(): Promise<void> {
    await this._wakeSubscription?.close();
    this._wakeSubscription = undefined;
  }

  protected async materialize(generation: number): Promise<void> {
    try {
      const contexts = await this._list();
      if (this.canPublishMaterialization(generation)) {
        this.publish(immutableState({ status: 'ready', contexts, savedFollows: this._getSavedFollows() }));
      }
    } catch (error: unknown) {
      if (this.canPublishMaterialization(generation)) {
        this.publishError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  protected statesEqual(previous: ContextViewState<Context>, next: ContextViewState<Context>): boolean {
    return statesEqual(previous, next);
  }

  protected handleLifetimeAbort(reason: unknown, sessionEnded: boolean): void {
    if (sessionEnded) {
      this.publishError(new Error('ContextView: owning session ended.', { cause: reason }));
    }
  }

  private publishError(error: Error): void {
    this.publish(immutableState({ ...this.getSnapshot(), status: 'error', error }));
  }
}

export function createMaterializedMemberContextView<Context extends { key: string }, Root>(
  options: MaterializedMemberContextViewOptions<Context, Root>,
): Promise<ContextView<MaterializedMemberContext<Context, Root>>> {
  type Binding = {
    context: Context;
    controller: AbortController;
    row: MaterializedMemberContext<Context, Root>;
    view?: RecordView<Root>;
  };

  const loading = Object.freeze({
    status: 'loading',
    records: Object.freeze([]),
    hasMore: false,
    current: false,
  }) as RecordViewState<Root>;

  let bindings = new Map<string, Binding>();
  let catalogVersion = 0;
  let listedVersion = -1;
  let closed = false;
  let wakeView = (): void => {};
  const openingQueue: Binding[] = [];
  const openingTasks = new Set<Promise<void>>();
  const cleanupTasks = new Set<Promise<void>>();

  const makeRow = (context: Context, root: RecordViewState<Root>): MaterializedMemberContext<Context, Root> =>
    Object.freeze({ context, root });

  const dispose = (binding: Binding): Promise<void> | undefined => {
    if (binding.controller.signal.aborted) {
      return undefined;
    }
    binding.controller.abort();
    const view = binding.view;
    binding.view = undefined;
    return view?.close();
  };

  const disposeQuietly = (binding: Binding): void => {
    const task = dispose(binding)?.catch((): void => {});
    if (task === undefined) {
      return;
    }
    cleanupTasks.add(task);
    void task.then((): void => {
      cleanupTasks.delete(task);
    });
  };

  const publishRoot = (binding: Binding, root: RecordViewState<Root>): void => {
    if (
      closed
      || binding.controller.signal.aborted
      || bindings.get(binding.context.key) !== binding
      || binding.row.root === root
    ) {
      return;
    }
    binding.row = makeRow(binding.context, root);
    wakeView();
  };

  const openBinding = async (binding: Binding): Promise<void> => {
    try {
      const view = await options.openRootView(binding.context, binding.controller.signal);
      if (closed || binding.controller.signal.aborted || bindings.get(binding.context.key) !== binding) {
        await view.close();
        return;
      }
      binding.view = view;
      view.subscribe((): void => {
        publishRoot(binding, view.getSnapshot());
      });
      publishRoot(binding, view.getSnapshot());
    } catch (error: unknown) {
      if (closed || binding.controller.signal.aborted || bindings.get(binding.context.key) !== binding) {
        return;
      }
      publishRoot(binding, Object.freeze({
        status: 'error',
        records: Object.freeze([]),
        hasMore: false,
        current: false,
        error: error instanceof Error ? error : new Error(String(error)),
      }));
    }
  };

  const drainOpenings = (): void => {
    while (!closed && openingTasks.size < MEMBER_ROOT_OPEN_CONCURRENCY && openingQueue.length > 0) {
      const binding = openingQueue.shift()!;
      if (binding.controller.signal.aborted || bindings.get(binding.context.key) !== binding) {
        continue;
      }
      const task = openBinding(binding);
      openingTasks.add(task);
      void task.finally((): void => {
        openingTasks.delete(task);
        drainOpenings();
      });
    }
  };

  const reconcile = (contexts: readonly Context[]): void => {
    const next = new Map<string, Binding>();
    for (const context of contexts) {
      let binding = bindings.get(context.key);
      if (
        binding === undefined
        || binding.context !== context
        || (binding.view === undefined && binding.row.root.status === 'error')
      ) {
        binding = {
          context,
          controller: new AbortController(),
          row: makeRow(context, loading),
        };
        openingQueue.push(binding);
      }
      next.set(context.key, binding);
    }
    for (const binding of bindings.values()) {
      if (next.get(binding.context.key) !== binding) {
        disposeQuietly(binding);
      }
    }
    bindings = next;
    drainOpenings();
  };

  return createContextView({
    callerSignal: options.callerSignal,
    getSavedFollows: options.getSavedFollows,
    list: async (): Promise<readonly MaterializedMemberContext<Context, Root>[]> => {
      const version = catalogVersion;
      if (listedVersion !== version) {
        const contexts = await options.listContexts();
        if (closed) {
          return [];
        }
        reconcile(contexts);
        listedVersion = version;
      }
      return Array.from(bindings.values(), binding => binding.row);
    },
    openWakeSubscription: async (wake, fail) => {
      wakeView = wake;
      const catalog = await options.openWakeSubscription((): void => {
        catalogVersion += 1;
        wake();
      }, fail);
      return {
        close: async (): Promise<void> => {
          closed = true;
          wakeView = (): void => {};
          openingQueue.length = 0;
          const closingViews = [...bindings.values()]
            .map(dispose)
            .filter((task): task is Promise<void> => task !== undefined);
          bindings.clear();
          const results = await Promise.allSettled([
            catalog.close(),
            ...openingTasks,
            ...closingViews,
            ...cleanupTasks,
          ]);
          const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
          if (failure !== undefined) {
            throw failure.reason;
          }
        },
      };
    },
    signal: options.signal,
  });
}

function immutableState<Context>(state: ContextViewState<Context>): ContextViewState<Context> {
  return Object.freeze({
    ...state,
    contexts: Object.freeze([...state.contexts]),
    savedFollows: Object.freeze(state.savedFollows.map(follow => Object.freeze({ ...follow }))),
  });
}

function statesEqual<Context>(a: ContextViewState<Context>, b: ContextViewState<Context>): boolean {
  return a.status === b.status
    && a.error === b.error
    && a.contexts.length === b.contexts.length
    && a.contexts.every((context, index) => context === b.contexts[index])
    && a.savedFollows.length === b.savedFollows.length
    && a.savedFollows.every((follow, index) => {
      const other = b.savedFollows[index]!;
      return follow.key === other.key
        && follow.id === other.id
        && follow.ownerDid === other.ownerDid
        && follow.path === other.path;
    });
}
