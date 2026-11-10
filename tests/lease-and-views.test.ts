import { describe, expect, it } from 'vitest';

import type {
  ExpandableRecordView,
  FollowedSyncSource,
  RecordViewState,
  SyncEngineHost,
  SyncEvent,
} from '../src/index.js';
import {
  ContextNotReadyError,
  ContextRetiredError,
  createContextView,
  createMaterializedMemberContextView,
  createProjectedRecordView,
  FollowedModuleLease,
} from '../src/index.js';
import { ObservedView } from '../src/observed-view.js';

const ROOT_URI = 'https://example.com/modules/notes';
const CONSUMER_URI = 'https://example.com/modules/notes-realtime';

function createFakeSync(initialSource?: FollowedSyncSource): {
  sync: SyncEngineHost;
  source: FollowedSyncSource | undefined;
  setSource(next: FollowedSyncSource | undefined): void;
  emit(event: SyncEvent): void;
  pullResult: boolean;
} {
  let current = initialSource;
  const listeners = new Set<(event: SyncEvent) => void>();
  let pullResult = true;
  return {
    get pullResult(): boolean {
      return pullResult;
    },
    set pullResult(value: boolean) {
      pullResult = value;
    },
    get source(): FollowedSyncSource | undefined {
      return current;
    },
    setSource(next: FollowedSyncSource | undefined): void {
      current = next;
    },
    emit(event: SyncEvent): void {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    sync: {
      followSource: async () => {
        if (current === undefined) {
          throw new Error('no source');
        }
        return current;
      },
      ensureFollowedSourceModules: async (src) => src,
      resolveFollowedSourceModuleGraph: async () => {
        throw new Error('not stubbed');
      },
      getFollowedSource: async (id) => (current?.id === id ? current : undefined),
      listFollowedSources: async () => (current === undefined ? [] : [current]),
      deleteFollowedSource: async () => {
        current = undefined;
      },
      pullFollowedSource: async () => pullResult,
      markFollowedSourcePullPending: async () => {},
      on: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } satisfies SyncEngineHost,
  };
}

function makeSource(overrides: Partial<FollowedSyncSource> = {}): FollowedSyncSource {
  return {
    id: 'role-1',
    acceptanceId: 'acc-1',
    actorDid: 'did:dht:bob',
    sourceDid: 'did:dht:alice',
    rootModule: ROOT_URI,
    contextId: 'nb1/pg1',
    roles: ['notebook/page/member'],
    remoteEndpoint: 'https://dwn.alice.example',
    modules: {
      [ROOT_URI]: {
        contextPath: 'notebook/page',
        moduleRole: 'notebook/page/member',
        modulePaths: ['notebook/page'],
      },
      [CONSUMER_URI]: {
        contextPath: 'page',
        moduleRole: 'core:notebook/page/member',
        modulePaths: ['page/live'],
      },
    },
    ...overrides,
  };
}

function makeInnerView<T>(initialRecords: readonly T[]): {
  view: ExpandableRecordView<T>;
  setRecords(records: readonly T[], current?: boolean): void;
  closed: () => boolean;
} {
  let closed = false;
  let state: RecordViewState<T> = Object.freeze({
    status: 'ready',
    current: true,
    hasMore: false,
    records: Object.freeze([...initialRecords]),
  });
  const listeners = new Set<(snapshot: RecordViewState<T>) => void>();
  return {
    closed: () => closed,
    setRecords(records: readonly T[], current = true): void {
      state = Object.freeze({
        status: 'ready',
        current,
        hasMore: false,
        records: Object.freeze([...records]),
      });
      for (const listener of [...listeners]) {
        listener(state);
      }
    },
    view: {
      getSnapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      ready: async () => {
        if (state.status !== 'ready') {
          throw new Error('not ready');
        }
        return state;
      },
      refresh: async () => {
        if (state.status !== 'ready') {
          throw new Error('not ready');
        }
        return state;
      },
      loadMore: async () => {},
      close: async () => {
        closed = true;
        listeners.clear();
      },
    },
  };
}

describe('FollowedModuleLease & ProjectedRecordView fixes', () => {
  it('retires a consumer lease when affectedModules changes mid-capture (#27)', async () => {
    const source = makeSource();
    const fakeSync = createFakeSync(source);
    const session = new AbortController();

    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });

    const rootLease = new FollowedModuleLease({
      module: ROOT_URI,
      source,
      sync: fakeSync.sync,
      signal: session.signal,
    });
    const consumerLease = new FollowedModuleLease({
      root: rootLease,
      module: CONSUMER_URI,
      source,
      sync: fakeSync.sync,
      signal: session.signal,
      onCapture: async () => {
        await captureGate;
      },
    });

    const pendingAssert = consumerLease.assertActive();
    await new Promise(resolve => setTimeout(resolve, 10));

    // Scope replacement event arrives BEFORE onCapture completes!
    fakeSync.emit({
      type: 'followed-context:change',
      actorDid: source.actorDid,
      tenantDid: source.sourceDid,
      module: ROOT_URI,
      contextId: source.contextId,
      followedSourceId: source.id,
      followedSourceAcceptanceId: source.acceptanceId,
      affectedModules: [CONSUMER_URI],
    });
    expect(consumerLease.signal.aborted).toBe(true);
    expect(consumerLease.signal.reason).toBeInstanceOf(ContextRetiredError);

    releaseCapture();
    await expect(pendingAssert).rejects.toBeInstanceOf(ContextRetiredError);
  });

  it('rejects refresh() with ContextNotReadyError instead of hanging when consumer stays unavailable (#20)', async () => {
    const unavailableSource = makeSource({
      modules: {
        [ROOT_URI]: {
          contextPath: 'notebook/page',
          moduleRole: 'notebook/page/member',
          modulePaths: ['notebook/page'],
        },
        [CONSUMER_URI]: null,
      },
    });
    const fakeSync = createFakeSync(unavailableSource);
    const session = new AbortController();
    const rootLease = new FollowedModuleLease({
      module: ROOT_URI,
      source: unavailableSource,
      sync: fakeSync.sync,
      signal: session.signal,
    });

    const projected = await createProjectedRecordView<string>({
      module: CONSUMER_URI,
      source: unavailableSource,
      root: rootLease,
      sync: fakeSync.sync,
      signal: session.signal,
      generation: () => ({
        signal: session.signal,
        open: async () => {
          throw new ContextNotReadyError();
        },
      }),
    });

    expect(projected.getSnapshot().status).toBe('loading');
    await expect(projected.refresh()).rejects.toBeInstanceOf(ContextNotReadyError);

    await projected.close();
    await expect(projected.refresh()).rejects.toThrow('closed');
  });

  it('closes ProjectedRecordView permanently when root authority retires (#21) and rotates generations on consumer recovery', async () => {
    const source = makeSource({
      modules: {
        [ROOT_URI]: {
          contextPath: 'notebook/page',
          moduleRole: 'notebook/page/member',
          modulePaths: ['notebook/page'],
        },
        [CONSUMER_URI]: null,
      },
    });
    const fakeSync = createFakeSync(source);
    const session = new AbortController();
    const rootLease = new FollowedModuleLease({
      module: ROOT_URI,
      source,
      sync: fakeSync.sync,
      signal: session.signal,
    });

    let consumerReady = false;
    const inner = makeInnerView(['live-1']);

    const projected = await createProjectedRecordView<string>({
      module: CONSUMER_URI,
      source,
      root: rootLease,
      sync: fakeSync.sync,
      signal: session.signal,
      generation: () => ({
        signal: session.signal,
        open: async () => {
          if (!consumerReady) {
            throw new ContextNotReadyError();
          }
          return inner.view;
        },
      }),
    });

    expect(projected.getSnapshot().status).toBe('loading');

    // Recover consumer via sync event
    consumerReady = true;
    fakeSync.emit({
      type: 'followed-context:change',
      actorDid: source.actorDid,
      tenantDid: source.sourceDid,
      module: ROOT_URI,
      contextId: source.contextId,
      followedSourceId: source.id,
      followedSourceAcceptanceId: source.acceptanceId,
      affectedModules: [CONSUMER_URI],
    });
    const readyState = await projected.ready();
    expect(readyState.records).toEqual(['live-1']);

    // Now test root retirement before opening a fresh projected view (#21)
    fakeSync.setSource(undefined);
    const retiredProjected = await createProjectedRecordView<string>({
      module: CONSUMER_URI,
      source,
      root: rootLease,
      sync: fakeSync.sync,
      signal: session.signal,
      generation: () => ({
        signal: session.signal,
        open: async () => inner.view,
      }),
    });
    await expect(retiredProjected.ready()).rejects.toBeInstanceOf(ContextRetiredError);
    expect(retiredProjected.getSnapshot().status).toBe('error');

    await projected.close();
    expect(inner.closed()).toBe(true);
  });

  it('joins in-flight materialization before ObservedView.close() resolves and coordinates materialized member views', async () => {
    let finishMaterialize!: () => void;
    let materializationFinished = false;
    const gate = new Promise<void>((resolve) => {
      finishMaterialize = resolve;
    });

    class SlowView extends ObservedView<{ status: 'loading' | 'ready' | 'error'; error?: Error }> {
      public constructor() {
        super({ status: 'loading' });
        this.requestMaterialization();
      }
      protected async materialize(): Promise<void> {
        await gate;
        materializationFinished = true;
      }
      protected async closeOwnedResources(): Promise<void> {}
    }

    const slow = new SlowView();
    let closeResolved = false;
    const closing = slow.close().then(() => {
      closeResolved = true;
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(closeResolved).toBe(false);
    finishMaterialize();
    await closing;
    expect(materializationFinished).toBe(true);
    expect(closeResolved).toBe(true);

    // Also verify createContextView & createMaterializedMemberContextView
    let wakeCatalog!: () => void;
    const rootInner = makeInnerView([{ title: 'Doc 1' }]);
    const matView = await createMaterializedMemberContextView({
      getSavedFollows: () => [{ key: 'k1', id: 'c1', ownerDid: 'did:dht:alice', path: 'page' }],
      listContexts: async () => [{ key: 'k1', path: 'page' }],
      openRootView: async () => rootInner.view,
      openWakeSubscription: async (wake) => {
        wakeCatalog = wake;
        return { close: async () => {} };
      },
    });
    const ready = await matView.ready();
    expect(ready.savedFollows).toHaveLength(1);
    // Wait for async root view open
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(matView.getSnapshot().contexts[0]?.root).toMatchObject({
      status: 'ready',
      records: [{ title: 'Doc 1' }],
    });
    wakeCatalog();
    await matView.close();
    expect(rootInner.closed()).toBe(true);

    const basicView = await createContextView({
      list: async () => ['ctx-a'],
      openWakeSubscription: async () => ({ close: async () => {} }),
    });
    expect((await basicView.ready()).contexts).toEqual(['ctx-a']);
    await basicView.close();
  });
});
