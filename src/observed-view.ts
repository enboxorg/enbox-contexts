/** Minimal external-store contract compatible with `useSyncExternalStore` and `@enbox/api`. */
export interface ObservableStore<State> {
  getSnapshot: () => State;
  subscribe: (listener: (snapshot: State) => void) => () => void;
}

/** Combine defined abort signals without allocating when zero or one signal is present. */
export function combineAbortSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const defined = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (defined.length === 0) {
    return undefined;
  }
  return defined.length === 1 ? defined[0] : AbortSignal.any(defined);
}

/** Race an async operation against one or more abort signals, detaching listeners on settle. */
export function whileSignalsActive<T>(
  operation: () => Promise<T>,
  signals: readonly (AbortSignal | undefined)[],
): Promise<T> {
  const signal = combineAbortSignals(...signals);
  if (signal === undefined) {
    return operation();
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error: unknown) {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) {
        reject(signal.reason);
      } else {
        reject(error);
      }
      return;
    }
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          reject(signal.reason);
        } else {
          resolve(value);
        }
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          reject(signal.reason);
        } else {
          reject(error);
        }
      },
    );
  });
}

/** Open an `ObservedView` while cleaning up owned resources on caller/session abort or failure. */
export async function openView<View extends { open(): Promise<void>; close(): Promise<void> }>(
  view: View,
  signals: readonly (AbortSignal | undefined)[],
): Promise<void> {
  try {
    await whileSignalsActive(() => view.open(), signals);
  } catch (error: unknown) {
    try {
      await view.close();
    } catch {
      // Preserve the primary opening error over secondary cleanup failures.
    }
    throw error;
  }
}

type ReadyWaiter<ReadyState> = {
  resolve(state: ReadyState): void;
  reject(reason: unknown): void;
  cleanup(): void;
};

/**
 * Shared state/materialization/ready/close base for live views in `@enbox/contexts`.
 * `close()` joins any in-flight materialization pass before resolving so callers
 * never observe post-close background reads.
 */
export abstract class ObservedView<
  State extends { readonly status: 'loading' | 'ready' | 'error'; readonly error?: Error },
> implements ObservableStore<State> {
  protected readonly _closeController = new AbortController();
  protected readonly _callerSignal?: AbortSignal;
  protected readonly _sessionSignal?: AbortSignal;

  private readonly _listeners = new Set<(snapshot: State) => void>();
  private readonly _waiters = new Set<ReadyWaiter<Extract<State, { status: 'ready' }>>>();
  private readonly _detachSignals: (() => void)[] = [];

  private _state: State;
  private _closed = false;
  private _closePromise?: Promise<void>;
  private _generation = 0;
  private _materializationRequested = false;
  private _activeMaterialization?: Promise<void>;

  public constructor(initialState: State, callerSignal?: AbortSignal, sessionSignal?: AbortSignal) {
    this._state = initialState;
    this._callerSignal = callerSignal;
    this._sessionSignal = sessionSignal;

    const attachAbort = (signal: AbortSignal | undefined, sessionEnded: boolean): void => {
      if (signal === undefined) {
        return;
      }
      const onAbort = (): void => {
        if (!this._closed) {
          this.handleLifetimeAbort(signal.reason, sessionEnded);
          void this.close().catch((): void => {});
        }
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this._detachSignals.push(() => signal.removeEventListener('abort', onAbort));
    };

    attachAbort(sessionSignal, true);
    attachAbort(callerSignal, false);
  }

  protected get isClosed(): boolean {
    return this._closed;
  }

  public getSnapshot(): State {
    return this._state;
  }

  public subscribe(listener: (snapshot: State) => void): () => void {
    if (this._closed) {
      return (): void => {};
    }
    this._listeners.add(listener);
    return (): void => {
      this._listeners.delete(listener);
    };
  }

  public ready(options?: Readonly<{ signal?: AbortSignal }>): Promise<Extract<State, { status: 'ready' }>> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    if (this._state.status === 'ready') {
      return Promise.resolve(this._state as Extract<State, { status: 'ready' }>);
    }
    if (this._state.status === 'error') {
      return Promise.reject(this._state.error);
    }
    if (this._closed) {
      return Promise.reject(this.closedError());
    }
    return new Promise<Extract<State, { status: 'ready' }>>((resolve, reject) => {
      const onAbort = (): void => {
        waiter.cleanup();
        this._waiters.delete(waiter);
        reject(signal!.reason);
      };
      const waiter: ReadyWaiter<Extract<State, { status: 'ready' }>> = {
        resolve,
        reject,
        cleanup: (): void => {
          signal?.removeEventListener('abort', onAbort);
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this._waiters.add(waiter);
    });
  }

  public close(): Promise<void> {
    this._closePromise ??= (async (): Promise<void> => {
      this._closed = true;
      this._materializationRequested = false;
      this._generation += 1;
      for (const detach of this._detachSignals.splice(0)) {
        detach();
      }
      this._closeController.abort();
      this._listeners.clear();
      const closedError = this._state.status === 'error' ? this._state.error : this.closedError();
      this.settleWaitersWithRejection(closedError);
      try {
        await this.closeOwnedResources();
      } finally {
        await this._activeMaterialization?.catch((): void => {});
      }
    })();
    return this._closePromise;
  }

  protected requestMaterialization(): void {
    if (this._closed) {
      return;
    }
    this._materializationRequested = true;
    if (this._activeMaterialization !== undefined) {
      return;
    }
    const drain = async (): Promise<void> => {
      while (!this._closed && this._materializationRequested) {
        this._materializationRequested = false;
        const generation = ++this._generation;
        await this.materialize(generation);
      }
    };
    const running = drain().finally(() => {
      if (this._activeMaterialization === running) {
        this._activeMaterialization = undefined;
      }
    });
    this._activeMaterialization = running;
  }

  protected waitForActiveMaterialization(): Promise<void> {
    return this._activeMaterialization ?? Promise.resolve();
  }

  protected canPublishMaterialization(generation: number): boolean {
    return !this._closed && generation === this._generation;
  }

  protected publish(next: State): void {
    const unchanged = this.statesEqual(this._state, next);
    this._state = next;
    if (next.status === 'ready') {
      for (const waiter of [...this._waiters]) {
        this._waiters.delete(waiter);
        waiter.cleanup();
        waiter.resolve(next as Extract<State, { status: 'ready' }>);
      }
    } else if (next.status === 'error') {
      this.settleWaitersWithRejection(next.error);
    }
    if (unchanged || this._closed) {
      return;
    }
    for (const listener of [...this._listeners]) {
      try {
        listener(next);
      } catch {
        // Isolate subscriber exceptions so remaining subscribers still update.
      }
    }
  }

  protected statesEqual(previous: State, next: State): boolean {
    return Object.is(previous, next);
  }

  protected handleLifetimeAbort(_reason: unknown, _sessionEnded: boolean): void {
    // Subclasses override when session termination should publish a terminal error state.
  }

  protected abstract materialize(generation: number): Promise<void>;
  protected abstract closeOwnedResources(): Promise<void>;

  private settleWaitersWithRejection(reason: unknown): void {
    for (const waiter of [...this._waiters]) {
      this._waiters.delete(waiter);
      waiter.cleanup();
      waiter.reject(reason);
    }
  }

  private closedError(): Error {
    if (this._callerSignal?.aborted) {
      return this._callerSignal.reason instanceof Error
        ? this._callerSignal.reason
        : new Error(String(this._callerSignal.reason));
    }
    if (this._sessionSignal?.aborted) {
      return this._sessionSignal.reason instanceof Error
        ? this._sessionSignal.reason
        : new Error(String(this._sessionSignal.reason));
    }
    return new Error('ObservedView: view was closed.');
  }
}
