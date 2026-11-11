import type { ContextFollowIntent } from './companion-module.js';
import type { SavedContextFollow } from './context-view.js';
import type {
  ContextFollowTarget,
  ContextRecord,
  EnboxModulesHost,
  ExpandableRecordView,
  FollowedSyncSource,
  ResolvedModuleGraph,
  SyncEngineHost,
  SyncEvent,
} from './host-types.js';

import {
  compareCodeUnits,
  compareRecordsNewestFirst,
  equalArrays,
  isValidContextId,
  moduleContextKey,
} from './companion-module.js';
import { ContextRetiredError, isFollowedSourceNotReadyError } from './errors.js';
import { followedSyncSourceActiveEqual, syncEventCoversModule } from './lease.js';
import { combineAbortSignals } from './observed-view.js';

export type ContextFollowRecord = Readonly<{
  id: string;
  timestamp: string;
  value: ContextFollowIntent;
}>;

export type FollowRequest = ContextFollowTarget & Readonly<{
  path: string;
}>;

export type AdditionalModulesSelector = (path: string) => readonly string[];

export type ContextFollowingOptions = {
  actorDid: string;
  companionModuleUri: string;
  rootModuleUri: string;
  rootGraph: ResolvedModuleGraph;
  modulesHost: Pick<EnboxModulesHost, 'resolveContextRoles'>;
  append(intent: ContextFollowIntent, after?: string): Promise<ContextFollowRecord>;
  openView(signal: AbortSignal): Promise<ExpandableRecordView<ContextRecord<ContextFollowIntent>>>;
  decodeRecord(record: ContextRecord<ContextFollowIntent>): Promise<ContextFollowRecord | undefined>;
  read(): Promise<readonly ContextFollowRecord[]>;
  signal?: AbortSignal;
  sync: Pick<
    SyncEngineHost,
    | 'followSource'
    | 'getFollowedSource'
    | 'listFollowedSources'
    | 'deleteFollowedSource'
    | 'ensureFollowedSourceModules'
  >;
};

type FollowingObserver = Readonly<{
  additionalModules?: AdditionalModulesSelector;
  onChange?(): void;
  onError(error: Error): void;
  signal?: AbortSignal;
}>;

type Observation = {
  attemptedRecordIds: Map<string, string>;
  controller: AbortController;
  draining?: Promise<void>;
  listeners: Set<FollowingObserver>;
  opening: Promise<void>;
  requested: boolean;
  view?: ExpandableRecordView<ContextRecord<ContextFollowIntent>>;
};

/**
 * Shared per-(enbox, companionModule) coordinator that serializes journal reads/writes
 * across `bindContexts` and all `.withModules()` handles.
 */
export class ContextFollowing {
  private readonly _options: ContextFollowingOptions;
  private readonly _pendingOperations = new Map<string, Promise<unknown>>();
  private readonly _latestIntentRecords = new Map<string, ContextFollowRecord>();
  private readonly _moduleReconciliations = new Map<string, Promise<void>>();
  private _observation?: Observation;

  public constructor(options: ContextFollowingOptions) {
    this._options = options;
  }

  public getSavedFollows(): readonly SavedContextFollow[] {
    return [...this._latestIntentRecords]
      .flatMap(([key, { value }]): SavedContextFollow[] =>
        value.following ? [{ key, id: value.contextId, ownerDid: value.ownerDid, path: value.path }] : [],
      )
      .sort((left, right): number => compareCodeUnits(left.key, right.key));
  }

  public follow(
    request: FollowRequest,
    additionalModules?: AdditionalModulesSelector,
  ): Promise<FollowedSyncSource> {
    const key = moduleContextKey(request.ownerDid, request.id);
    return this.serializeContextOperation(key, async (): Promise<FollowedSyncSource> => {
      const roles = this.resolveContextRoles(request.path, request.id);
      const selectedModules = this.collectModules(request.path, additionalModules);
      const initialDecision = (await this.readLatestIntents()).get(key);
      const acceptedBeforeFollow = await this._options.sync.listFollowedSources();
      const source = await this.verifyAndAcceptContext(request, roles, selectedModules);
      const wroteDecision = await this.saveFollowUnlessNewerForget(request, initialDecision)
        .catch((error: unknown): Promise<never> => this.rollbackFailedFollow(source, acceptedBeforeFollow, error));

      if (wroteDecision) {
        await this.readLatestIntents();
      }
      await this.rejectFollowIfForgotten(request);
      this.reconcileAdditionalModules(source, selectedModules);
      return source;
    });
  }

  public forgetContext(target: ContextFollowTarget): Promise<void> {
    const key = moduleContextKey(target.ownerDid, target.id);
    return this.serializeContextOperation(key, async (): Promise<void> => {
      const previous = (await this.readLatestIntents()).get(key);
      await this.saveForgetDecision(target, previous);
    });
  }

  public forget(source: FollowedSyncSource, withdrawRole?: () => Promise<void>): Promise<void> {
    const target = { id: source.contextId, ownerDid: source.sourceDid };
    const key = moduleContextKey(target.ownerDid, target.id);
    return this.serializeContextOperation(key, async (): Promise<void> => {
      const current = await this._options.sync.getFollowedSource(source.id);
      this.assertActive();
      if (current === undefined || !followedSyncSourceActiveEqual(current, source)) {
        if (withdrawRole !== undefined) {
          throw new ContextRetiredError(source.contextId);
        }
        return;
      }
      const previous = (await this.readLatestIntents()).get(key);
      if (withdrawRole !== undefined) {
        await withdrawRole();
        await this.readLatestIntents();
      } else {
        const active = await this._options.sync.getFollowedSource(source.id);
        this.assertActive();
        if (active === undefined || !followedSyncSourceActiveEqual(active, source)) {
          return;
        }
      }
      const received = this._latestIntentRecords.get(key);
      if (!sameRecord(previous, received)) {
        if (received?.value.following === false) {
          await this.removeForgottenAcceptances(received);
        }
        return;
      }
      await this.saveForgetDecision(target, previous);
    });
  }

  public async restore(additionalModules?: AdditionalModulesSelector): Promise<void> {
    await this.readLatestIntents();
    await Promise.all(
      [...this._latestIntentRecords.keys()].map((key): Promise<void> =>
        this.serializeContextOperation(key, (): Promise<void> => this.restoreContext(key, additionalModules)),
      ),
    );
  }

  public retryAfterSync(event: SyncEvent): void {
    switch (event.type) {
      case 'pull:currentness-change':
        if (event.tenantDid !== this._options.actorDid || !event.to) {
          return;
        }
        break;
      case 'link:connectivity-change':
        if (event.to !== 'online') {
          return;
        }
        break;
      case 'reconcile:completed':
        break;
      default:
        return;
    }

    const observation = this._observation;
    if (observation === undefined || !this.isObserving(observation)) {
      return;
    }

    if (event.tenantDid === this._options.actorDid) {
      if (!syncEventCoversModule(event, this._options.companionModuleUri)) {
        return;
      }
      observation.attemptedRecordIds.clear();
      void this.requestReconciliation(observation);
      return;
    }

    if (!syncEventCoversModule(event, this._options.rootModuleUri)) {
      return;
    }
    let matched = false;
    for (const [key, record] of this._latestIntentRecords) {
      if (
        record.value.ownerDid !== event.tenantDid
        || (event.contextId !== undefined && !matchesContextSubtree(event.contextId, record.value.contextId))
      ) {
        continue;
      }
      observation.attemptedRecordIds.delete(key);
      matched = true;
    }
    if (matched) {
      void this.requestReconciliation(observation);
    }
  }

  public async observe(observer: FollowingObserver): Promise<{ close(): Promise<void> }> {
    const { signal } = observer;
    this.assertActive();
    signal?.throwIfAborted();
    const wasAlreadyOpen = this._observation !== undefined;
    const observation = this._observation ?? this.openObservation();
    const listener = { ...observer };
    observation.listeners.add(listener);
    let closed: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closed !== undefined) {
        return closed;
      }
      signal?.removeEventListener('abort', abort);
      observation.listeners.delete(listener);
      closed = observation.listeners.size === 0 ? this.closeObservation(observation) : Promise.resolve();
      return closed;
    };
    const abort = (): void => {
      void close().catch((): void => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await observation.opening;
      this.assertActive();
      signal?.throwIfAborted();
      if (wasAlreadyOpen && observer.additionalModules !== undefined) {
        observation.attemptedRecordIds.clear();
        void this.requestReconciliation(observation);
      }
      return { close };
    } catch (error: unknown) {
      await close();
      throw error;
    }
  }

  private collectModules(path: string, callerModules?: AdditionalModulesSelector): readonly string[] {
    const set = new Set<string>(callerModules?.(path) ?? []);
    if (this._observation !== undefined && this.isObserving(this._observation)) {
      for (const listener of this._observation.listeners) {
        for (const uri of listener.additionalModules?.(path) ?? []) {
          set.add(uri);
        }
      }
    }
    return [...set];
  }

  private async saveForgetDecision(
    target: ContextFollowTarget,
    previous: ContextFollowRecord | undefined,
  ): Promise<void> {
    const key = moduleContextKey(target.ownerDid, target.id);
    if (previous?.value.following !== false && this._latestIntentRecords.get(key)?.value.following !== false) {
      this.rememberLatestIntents([
        await this._options.append(
          {
            contextId: target.id,
            following: false,
            ownerDid: target.ownerDid,
          },
          previous?.timestamp,
        ),
      ]);
    }
    const latest = (await this.readLatestIntents()).get(key);
    if (latest?.value.following === false) {
      await this.removeForgottenAcceptances(latest);
    }
  }

  private verifyAndAcceptContext(
    request: FollowRequest,
    roles: readonly [string, ...string[]],
    modules: readonly string[],
  ): Promise<FollowedSyncSource> {
    this.assertActive();
    return this._options.sync.followSource({
      actorDid: this._options.actorDid,
      contextId: request.id,
      rootModule: this._options.rootModuleUri,
      contextPath: request.path,
      modules,
      roles: [...roles],
      sourceDid: request.ownerDid,
    });
  }

  private reconcileAdditionalModules(source: FollowedSyncSource, modules: readonly string[]): void {
    if (modules.length === 0 || this._options.signal?.aborted) {
      return;
    }
    const key = JSON.stringify([source.id, source.acceptanceId, modules]);
    if (this._moduleReconciliations.has(key)) {
      return;
    }
    const pending = this._options.sync
      .ensureFollowedSourceModules(source, modules)
      .then(
        (): void => {},
        (error: unknown): void => {
          if (!this._options.signal?.aborted && !isFollowedSourceNotReadyError(error)) {
            console.warn(
              '[@enbox/contexts] Unable to prepare optional context modules; the root follow remains unchanged.',
              error,
            );
          }
        },
      )
      .finally((): void => {
        this._moduleReconciliations.delete(key);
      });
    this._moduleReconciliations.set(key, pending);
  }

  private async saveFollowUnlessNewerForget(
    request: FollowRequest,
    initialDecision: ContextFollowRecord | undefined,
  ): Promise<boolean> {
    const key = moduleContextKey(request.ownerDid, request.id);
    const latest = (await this.readLatestIntents()).get(key);
    if (latest?.value.following === true && latest.value.path === request.path) {
      return false;
    }
    if (!sameRecord(initialDecision, latest) && latest?.value.following === false) {
      return false;
    }
    const written = await this._options.append(
      {
        contextId: request.id,
        following: true,
        path: request.path,
        ownerDid: request.ownerDid,
      },
      latest?.timestamp,
    );
    this.rememberLatestIntents([written]);
    return true;
  }

  private async rollbackFailedFollow(
    source: FollowedSyncSource,
    acceptedBeforeFollow: readonly FollowedSyncSource[],
    error: unknown,
  ): Promise<never> {
    if (
      !this._options.signal?.aborted
      && !acceptedBeforeFollow.some((previous): boolean => followedSyncSourceActiveEqual(previous, source))
    ) {
      try {
        await this._options.sync.deleteFollowedSource(source);
        this._observation?.attemptedRecordIds.delete(moduleContextKey(source.sourceDid, source.contextId));
      } catch (retireError: unknown) {
        throw new AggregateError(
          [error, retireError],
          'ContextFollowing: unable to complete or retire the new acceptance.',
        );
      }
    }
    throw error;
  }

  private async rejectFollowIfForgotten(request: FollowRequest): Promise<void> {
    const latest = this._latestIntentRecords.get(moduleContextKey(request.ownerDid, request.id));
    if (latest?.value.following === false) {
      await this.removeForgottenAcceptances(latest);
      throw new ContextRetiredError(request.id);
    }
  }

  private openObservation(): Observation {
    const observation: Observation = {
      attemptedRecordIds: new Map(),
      controller: new AbortController(),
      listeners: new Set(),
      opening: Promise.resolve(),
      requested: false,
    };
    this._observation = observation;
    const signal = combineAbortSignals(observation.controller.signal, this._options.signal)!;
    observation.opening = Promise.resolve().then(async (): Promise<void> => {
      const view = await this._options.openView(signal);
      if (!this.isObserving(observation)) {
        await view.close();
        return;
      }
      observation.view = view;
      view.subscribe((): void => {
        void this.requestReconciliation(observation);
      });
      await this.requestReconciliation(observation);
    });
    return observation;
  }

  private async closeObservation(observation: Observation): Promise<void> {
    if (this._observation === observation) {
      this._observation = undefined;
    }
    observation.controller.abort();
    await observation.opening.catch((): void => {});
    await observation.view?.close();
  }

  private requestReconciliation(observation: Observation): Promise<void> {
    if (!this.isObserving(observation) || observation.view === undefined) {
      return Promise.resolve();
    }
    observation.requested = true;
    if (observation.draining !== undefined) {
      return observation.draining;
    }
    const task = this.reconcileObservation(observation);
    observation.draining = task;
    const finish = (): void => {
      observation.draining = undefined;
      if (observation.requested) {
        void this.requestReconciliation(observation);
      }
    };
    void task.then(finish, (error: unknown): void => {
      this.report(observation, error);
      finish();
    });
    return task;
  }

  private async reconcileObservation(observation: Observation): Promise<void> {
    const view = observation.view!;
    observation.requested = false;
    await view.ready({ signal: observation.controller.signal });
    while (this.isObserving(observation) && view.getSnapshot().hasMore) {
      await view.loadMore();
    }
    if (!this.isObserving(observation)) {
      return;
    }
    const state = view.getSnapshot();
    if (state.status === 'error') {
      throw state.error;
    }
    const decoded = (
      await Promise.all(state.records.map(record => this._options.decodeRecord(record)))
    ).filter((row): row is ContextFollowRecord => row !== undefined);
    if (!this.isObserving(observation)) {
      return;
    }
    this.rememberLatestIntents(decoded);
    for (const [key, record] of this._latestIntentRecords) {
      if (observation.attemptedRecordIds.get(key) === record.id || this._pendingOperations.has(key)) {
        continue;
      }
      observation.attemptedRecordIds.set(key, record.id);
      void this.serializeContextOperation(key, async (): Promise<void> => {
        if (this.isObserving(observation)) {
          await this.restoreContext(key);
        }
      }).catch((error: unknown): void => {
        this.report(observation, error);
      });
    }
  }

  private async restoreContext(
    key: string,
    additionalModules?: AdditionalModulesSelector,
  ): Promise<void> {
    const current = this._latestIntentRecords.get(key)!;
    const intent = current.value;
    if (!intent.following) {
      await this.removeForgottenAcceptances(current);
      return;
    }
    let roles: readonly [string, ...string[]];
    try {
      roles = this.resolveContextRoles(intent.path, intent.contextId);
    } catch (error: unknown) {
      if (error instanceof TypeError) {
        return;
      }
      throw error;
    }
    const selectedModules = this.collectModules(intent.path, additionalModules);
    const sources = await this.listAcceptedContextSources(intent);
    const existing = sources.find((source): boolean => equalArrays(source.roles, roles));
    if (existing !== undefined) {
      this.reconcileAdditionalModules(existing, selectedModules);
    } else {
      await this.verifyAndAcceptContext(
        {
          path: intent.path,
          id: intent.contextId,
          ownerDid: intent.ownerDid,
        },
        roles,
        selectedModules,
      ).then(
        (source) => {
          this.reconcileAdditionalModules(source, selectedModules);
          return this.readLatestIntents();
        },
        (error: unknown): void => {
          this.assertActive();
          if (!isFollowedSourceNotReadyError(error)) {
            console.warn('[@enbox/contexts] Unable to restore a saved context; the follow choice is retained.', error);
          }
        },
      );
    }
    const latest = this._latestIntentRecords.get(key);
    if (latest?.value.following === false) {
      await this.removeForgottenAcceptances(latest);
    }
  }

  private async removeForgottenAcceptances(record: ContextFollowRecord): Promise<void> {
    const key = moduleContextKey(record.value.ownerDid, record.value.contextId);
    let sources = await this.listAcceptedContextSources(record.value);
    while (sources.length > 0 && this._latestIntentRecords.get(key)?.value.following === false) {
      await Promise.all(sources.map((source): Promise<unknown> => this._options.sync.deleteFollowedSource(source)));
      await this.readLatestIntents();
      if (this._latestIntentRecords.get(key)?.value.following !== false) {
        return;
      }
      sources = await this.listAcceptedContextSources(record.value);
    }
  }

  private async listAcceptedContextSources(intent: ContextFollowIntent): Promise<FollowedSyncSource[]> {
    const sources = await this._options.sync.listFollowedSources();
    this.assertActive();
    return sources.filter(
      (source): boolean =>
        source.actorDid === this._options.actorDid
        && source.rootModule === this._options.rootModuleUri
        && source.sourceDid === intent.ownerDid
        && source.contextId === intent.contextId,
    );
  }

  private rememberLatestIntents(records: readonly ContextFollowRecord[]): void {
    let changed = false;
    for (const record of records) {
      const key = moduleContextKey(record.value.ownerDid, record.value.contextId);
      const previous = this._latestIntentRecords.get(key);
      if (previous === undefined || compareRecordsNewestFirst(record, previous) < 0) {
        this._latestIntentRecords.set(key, record);
        changed = true;
      }
    }
    if (changed && this._observation !== undefined) {
      this.notifyObservers(this._observation, (listener): void => {
        listener.onChange?.();
      });
    }
  }

  private async readLatestIntents(): Promise<ReadonlyMap<string, ContextFollowRecord>> {
    this.assertActive();
    const records = await this._options.read();
    this.assertActive();
    this.rememberLatestIntents(records);
    return this._latestIntentRecords;
  }

  private resolveContextRoles(path: string, contextId: string): readonly [string, ...string[]] {
    const node = this._options.rootGraph.nodesByDeclaredPath.get(path);
    if (node?.kind !== 'record' || node.ruleSet.$role === true) {
      throw new TypeError(`ContextFollowing: '${path}' is not a record root in '${this._options.rootModuleUri}'.`);
    }
    if (!isValidContextId(contextId) || node.physicalDepth !== contextId.split('/').length) {
      throw new TypeError(`ContextFollowing: context ID does not identify a '${path}' root.`);
    }
    const roles = this._options.modulesHost.resolveContextRoles(this._options.rootGraph, path);
    if (roles.length === 0) {
      throw new TypeError(`ContextFollowing: '${path}' is not a shared context root.`);
    }
    return roles as readonly [string, ...string[]];
  }

  private serializeContextOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const task = (this._pendingOperations.get(key) ?? Promise.resolve())
      .catch((): void => {})
      .then((): Promise<T> => {
        this.assertActive();
        return operation();
      });
    this._pendingOperations.set(key, task);
    const release = (): void => {
      if (this._pendingOperations.get(key) === task) {
        this._pendingOperations.delete(key);
        const observation = this._observation;
        if (
          observation !== undefined
          && observation.attemptedRecordIds.get(key) !== this._latestIntentRecords.get(key)?.id
        ) {
          void this.requestReconciliation(observation);
        }
      }
    };
    void task.then(release, release);
    return task;
  }

  private assertActive(): void {
    this._options.signal?.throwIfAborted();
  }

  private isObserving(observation: Observation): boolean {
    return this._observation === observation && !this._options.signal?.aborted;
  }

  private report(observation: Observation, error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.notifyObservers(observation, (listener): void => {
      listener.onError(failure);
    });
  }

  private notifyObservers(observation: Observation, notify: (listener: FollowingObserver) => void): void {
    if (this.isObserving(observation)) {
      for (const listener of [...observation.listeners]) {
        try {
          notify(listener);
        } catch {
          // Isolate observer callback errors.
        }
      }
    }
  }
}

function sameRecord(left: ContextFollowRecord | undefined, right: ContextFollowRecord | undefined): boolean {
  return left?.id === right?.id;
}

function matchesContextSubtree(eventContextId: string, targetContextId: string): boolean {
  return eventContextId === targetContextId
    || targetContextId.startsWith(`${eventContextId}/`)
    || eventContextId.startsWith(`${targetContextId}/`);
}
