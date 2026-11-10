import type {
  FollowedModuleScope,
  FollowedSyncSource,
  RecordExecutionContext,
  SyncEngineHost,
  SyncEvent,
  SyncEventScope,
} from './host-types.js';

import { combineAbortSignals, whileSignalsActive } from './observed-view.js';
import { ContextNotReadyError, ContextRetiredError, isContextNotReadyError } from './errors.js';

export type FollowedModuleLeaseOptions = {
  module: string;
  source: FollowedSyncSource;
  sync: SyncEngineHost;
  signal: AbortSignal;
  root?: FollowedModuleLease;
  onCapture?(scope: FollowedModuleScope, source: FollowedSyncSource): void | Promise<void>;
};

export function followedModuleScopeEqual(
  left: FollowedModuleScope | null | undefined,
  right: FollowedModuleScope | null | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left.contextPath === right.contextPath
    && left.moduleRole === right.moduleRole
    && left.modulePaths.length === right.modulePaths.length
    && left.modulePaths.every((path, index) => path === right.modulePaths[index]);
}

export function followedSyncSourceActiveEqual(
  left: FollowedSyncSource,
  right: FollowedSyncSource,
): boolean {
  return left.id === right.id
    && left.acceptanceId === right.acceptanceId
    && left.actorDid === right.actorDid
    && left.sourceDid === right.sourceDid
    && left.rootModule === right.rootModule
    && left.contextId === right.contextId
    && left.remoteEndpoint === right.remoteEndpoint
    && followedModuleScopeEqual(left.modules[left.rootModule], right.modules[right.rootModule]);
}

export function syncEventCoversModule(scope: SyncEventScope, moduleUri: string): boolean {
  if (scope.modules !== undefined) {
    return scope.modules.includes(moduleUri);
  }
  return scope.module === undefined || scope.module === moduleUri;
}

function followedContextChangeRetiresSource(
  source: Pick<FollowedSyncSource, 'acceptanceId' | 'id'>,
  event: Extract<SyncEvent, { type: 'followed-context:change' }>,
): boolean {
  return event.followedSourceId === undefined
    ? event.followedSourceAcceptanceId === source.acceptanceId
    : event.followedSourceId !== source.id || event.followedSourceAcceptanceId !== source.acceptanceId;
}

/** One captured module scope, fenced by its root acceptance and the owning session. */
export class FollowedModuleLease {
  public readonly signal: AbortSignal;
  private readonly _controller = new AbortController();
  private _scope?: FollowedModuleScope;
  private _capturing?: Promise<void>;
  private _unsubscribe?: () => void;

  public constructor(private readonly _options: FollowedModuleLeaseOptions) {
    this.signal = combineAbortSignals(_options.root?.signal, _options.signal, this._controller.signal)!;
    if (_options.module === _options.source.rootModule) {
      const rootScope = _options.source.modules[_options.module];
      if (rootScope !== undefined && rootScope !== null) {
        this._scope = structuredClone(rootScope);
      }
    }
  }

  public executionContext(invokeRole = true): RecordExecutionContext {
    const role = (): string | undefined => {
      if (!invokeRole) {
        return undefined;
      }
      if (this._scope === undefined) {
        throw new ContextNotReadyError();
      }
      return this._scope.moduleRole;
    };
    const { source } = this._options;
    return {
      assertActive: invokeRole
        ? (): Promise<void> => this.assertActive()
        : async (): Promise<void> => { await this.currentSource(); },
      contextId: source.contextId,
      followedSourceId: invokeRole ? source.id : undefined,
      invalidateReplica: async (): Promise<void> => {
        const current = await this.assertScope();
        await this._options.sync.markFollowedSourcePullPending(current, this._options.module);
      },
      get moduleRole(): string | undefined {
        return role();
      },
      remoteEndpoint: source.remoteEndpoint,
      tenantDid: source.sourceDid,
    };
  }

  public async currentSource(): Promise<FollowedSyncSource> {
    this.start();
    const { root, source, sync } = this._options;
    const current = await whileSignalsActive(
      () => (root === undefined ? sync.getFollowedSource(source.id) : root.currentSource()),
      [this.signal],
    );
    if (current === undefined || !followedSyncSourceActiveEqual(this._options.source, current)) {
      throw this.retire();
    }
    return current;
  }

  public async assertActive(): Promise<void> {
    await this.assertScope();
  }

  public async refresh(): Promise<void> {
    const current = await this.assertScope();
    try {
      if (!await this._options.sync.pullFollowedSource(current, this._options.module)) {
        throw new ContextNotReadyError(new Error('Replication did not reach the feed head for the selected module.'));
      }
    } catch (error: unknown) {
      await this.assertScope();
      throw isContextNotReadyError(error) ? error : new ContextNotReadyError(error);
    }
    await this.assertScope();
  }

  private async assertScope(): Promise<FollowedSyncSource> {
    const current = await this.currentSource();
    const scope = current.modules[this._options.module];
    if (
      this._scope !== undefined
      && (scope === undefined || scope === null || !followedModuleScopeEqual(this._scope, scope))
    ) {
      throw this.retire();
    }
    if (scope === undefined || scope === null) {
      throw new ContextNotReadyError();
    }
    if (this._scope === undefined) {
      this._capturing ??= (async (): Promise<void> => {
        await this._options.onCapture?.(scope, current);
        const latest = await this.currentSource();
        const accepted = latest.modules[this._options.module];
        if (accepted === undefined || accepted === null || !followedModuleScopeEqual(scope, accepted)) {
          throw this.retire();
        }
        this._scope = structuredClone(scope);
      })().finally(() => {
        this._capturing = undefined;
      });
      await whileSignalsActive(() => this._capturing!, [this.signal]);
    }
    return current;
  }

  private start(): void {
    this.signal.throwIfAborted();
    if (this._unsubscribe !== undefined) {
      return;
    }
    this._unsubscribe = this._options.sync.on(event => this.handleEvent(event));
    this.signal.addEventListener(
      'abort',
      () => {
        this._unsubscribe?.();
        this._unsubscribe = undefined;
      },
      { once: true },
    );
  }

  private handleEvent(event: SyncEvent): void {
    const { source, module, root } = this._options;
    if (
      event.type === 'identity:registration-change'
      || event.type === 'dead-letter:change'
      || event.tenantDid !== source.sourceDid
      || (event.contextId !== undefined && event.contextId !== source.contextId)
    ) {
      return;
    }
    if (event.type === 'followed-context:change' && event.actorDid === source.actorDid && event.module === source.rootModule) {
      if (root === undefined && followedContextChangeRetiresSource(source, event)) {
        this.retire();
        return;
      }
      // Retire both already-captured and mid-capture leases when the consumer scope changes (#27).
      if ((this._scope !== undefined || this._capturing !== undefined) && event.affectedModules?.includes(module)) {
        this.retire();
        return;
      }
    } else if (!syncEventCoversModule(event, module)) {
      return;
    }
    if (this._scope !== undefined) {
      void this.assertScope().catch((): void => {});
    }
  }

  private retire(): ContextRetiredError {
    const error = new ContextRetiredError(this._options.source.contextId);
    this._controller.abort(error);
    return error;
  }
}
