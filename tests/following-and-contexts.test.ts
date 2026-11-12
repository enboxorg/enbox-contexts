import { describe, expect, it } from 'vitest';

import type {
  ContextRecord,
  ContextRecordsApi,
  EnboxHost,
  ExpandableRecordView,
  FollowedSyncSource,
  HostDwnApi,
  ModuleDefinition,
  RecordCodec,
  RecordPage,
  RecordViewState,
  ResolvedModuleGraph,
  ResolvedModuleNode,
  ScopedRecordsOptions,
  SyncEngineHost,
  SyncEvent,
  TypedEnboxHost,
  TypedModule,
} from '../src/index.js';
import {
  bindContexts,
  CONTEXT_FOLLOW_PATH,
  CONTEXT_INVITATION_PATH,
  ContextNotReadyError,
  defineContextModule,
} from '../src/index.js';
import { jsonCodec } from './test-helpers.js';

function makeModule<
  const D extends ModuleDefinition,
  C extends Record<string, RecordCodec<unknown>>,
  Deps extends Record<string, TypedModule> = Record<string, never>,
>(definition: D, codecs: C, dependencies?: Deps): TypedModule<D, C, Deps> {
  return {
    definition,
    codecs,
    dependencies: (dependencies ?? {}) as Deps,
  };
}

const OWNER_DID = 'did:dht:owner123';
const MEMBER_DID = 'did:dht:member456';

const NotebookModule = makeModule(
  {
    module: 'https://example.com/modules/notebooks/v1',
    published: true,
    types: {
      notebook: { dataFormats: ['application/json'] },
      page: { dataFormats: ['application/json'], encryptionRequired: true },
      title: { dataFormats: ['application/json'], encryptionRequired: true },
      member: { dataFormats: ['application/json'] },
      viewer: { dataFormats: ['application/json'] },
    },
    structure: {
      notebook: {
        page: {
          $actions: [
            { role: 'notebook/page/member', can: ['read'] },
            { role: 'notebook/page/viewer', can: ['read'] },
          ],
          title: {
            $recordLimit: { max: 1 },
            $actions: [
              { role: 'notebook/page/member', can: ['read', 'co-update'] },
              { role: 'notebook/page/viewer', can: ['read'] },
            ],
          },
          member: { $role: true },
          viewer: { $role: true },
        },
      },
    },
  },
  {
    notebook: jsonCodec<{ name: string }>(),
    page: jsonCodec<{ summary: string }>(),
    title: jsonCodec<{ title: string }>(),
    member: jsonCodec<{ name: string }>(),
    viewer: jsonCodec<{ name: string }>(),
  },
);

const RealtimeModule = makeModule(
  {
    module: 'https://example.com/modules/notebooks-realtime/v1',
    published: true,
    uses: { core: 'https://example.com/modules/notebooks/v1' },
    types: {
      live: { dataFormats: ['application/json'], encryptionRequired: true },
    },
    structure: {
      page: {
        $ref: 'core:notebook/page',
        live: {
          $recordLimit: { max: 1 },
          // Only `member` role can read/write `page/live`; `viewer` has NO readable paths here (#12)!
          $actions: [{ role: 'core:notebook/page/member', can: ['create', 'read', 'co-update'] }],
        },
      },
    },
  },
  {
    live: jsonCodec<{ relay: string }>(),
  },
  { core: NotebookModule },
);

const NotebookContextsModule = defineContextModule(NotebookModule);

const testGraphs = new WeakMap<TypedModule, ResolvedModuleGraph>();

function buildTestGraph(mod: TypedModule): ResolvedModuleGraph {
  const cached = testGraphs.get(mod);
  if (cached !== undefined) {
    return cached;
  }
  const nodes = new Map<string, ResolvedModuleNode>();
  const uri = mod.definition.module;
  const resolveInvokedRole = (rolePath: string) => {
    if (rolePath.includes(':')) {
      const [alias, target] = rolePath.split(':') as [string, string];
      const dep = mod.dependencies[alias]!;
      const depRole = buildTestGraph(dep).resolveInvokedRole(target);
      return {
        ...depRole,
        rawRole: rolePath,
      };
    }
    const roleNode = nodes.get(rolePath);
    const parentAncestor = roleNode?.physicalAncestors[roleNode.physicalAncestors.length - 1];
    return {
      owningModuleUri: uri,
      owningModulePath: rolePath,
      rawRole: rolePath,
      parentAncestor,
      ruleSet: roleNode?.ruleSet ?? { $role: true },
    };
  };
  const walk = (
    structure: Record<string, unknown>,
    prefix: string,
    ancestors: { owningModuleUri: string; owningModulePath: string }[],
  ): void => {
    for (const [key, raw] of Object.entries(structure)) {
      if (key.startsWith('$') || raw === null || typeof raw !== 'object') {
        continue;
      }
      const ruleSet = raw as ModuleDefinition['structure'][string];
      const declPath = prefix ? `${prefix}/${key}` : key;
      if (typeof ruleSet.$ref === 'string') {
        const [alias, targetPath] = ruleSet.$ref.split(':') as [string, string];
        const dep = mod.dependencies[alias]!;
        const depGraph = buildTestGraph(dep);
        const targetNode = depGraph.nodesByDeclaredPath.get(targetPath)!;
        const attachNode: ResolvedModuleNode = {
          kind: 'ref',
          declaringModuleUri: uri,
          declaringModulePath: declPath,
          owningModuleUri: targetNode.owningModuleUri,
          owningModulePath: targetNode.owningModulePath,
          physicalAncestors: targetNode.physicalAncestors,
          physicalDepth: targetNode.physicalDepth,
          typeName: key,
          recordType: {},
          ruleSet: targetNode.ruleSet,
          actions: [],
        };
        nodes.set(declPath, attachNode);
        walk(ruleSet, declPath, [...targetNode.physicalAncestors, {
          owningModuleUri: targetNode.owningModuleUri,
          owningModulePath: targetNode.owningModulePath,
        }]);
      } else {
        const node: ResolvedModuleNode = {
          kind: 'record',
          declaringModuleUri: uri,
          declaringModulePath: declPath,
          owningModuleUri: uri,
          owningModulePath: declPath,
          physicalAncestors: ancestors,
          physicalDepth: ancestors.length + 1,
          typeName: key,
          recordType: mod.definition.types[key] ?? {},
          ruleSet,
          actions: [],
        };
        nodes.set(declPath, node);
        walk(ruleSet, declPath, [...ancestors, { owningModuleUri: uri, owningModulePath: declPath }]);
      }
    }
  };
  walk(mod.definition.structure, '', []);
  for (const node of nodes.values()) {
    if (node.kind !== 'record') {
      continue;
    }
    const resolvedActions = (node.ruleSet.$actions ?? []).map(rule => ({
      rule,
      resolvedRole: rule.role === undefined ? undefined : resolveInvokedRole(rule.role),
    }));
    nodes.set(node.declaringModulePath, { ...node, actions: resolvedActions });
  }
  const graph: ResolvedModuleGraph = {
    rootModuleUri: uri,
    nodesByDeclaredPath: nodes,
    resolveInvokedRole,
  };
  testGraphs.set(mod, graph);
  return graph;
}

type StoredRow = {
  id: string;
  module: string;
  modulePath: string;
  contextId: string;
  creator: string;
  recipient?: string;
  timestamp: string;
  data: unknown;
};

function createTestEnboxHost(connectedDid: string): {
  enbox: EnboxHost;
  rows: StoredRow[];
  sources: Map<string, FollowedSyncSource>;
  ensureReadyCalls: { module: string; path: string }[];
  followSourceCalls: { modules: readonly string[] }[];
  ensureModulesCalls: { modules: readonly string[] }[];
  scopeCalls: { module: string; options: ScopedRecordsOptions }[];
  scopedSubscribeCalls: { contextId: string; module: string; selection: string | readonly string[] }[];
  unscopedSubscribeCalls: { module: string; selection: string | readonly string[] }[];
  resolveGraphOverride?: (source: FollowedSyncSource, moduleUri: string) => Promise<ResolvedModuleGraph>;
  emitSync(event: SyncEvent): void;
  abortSession(): void;
} {
  const sessionController = new AbortController();
  const rows: StoredRow[] = [];
  const sources = new Map<string, FollowedSyncSource>();
  const syncListeners = new Set<(event: SyncEvent) => void>();
  const ensureReadyCalls: { module: string; path: string }[] = [];
  const followSourceCalls: { modules: readonly string[] }[] = [];
  const ensureModulesCalls: { modules: readonly string[] }[] = [];
  const scopeCalls: { module: string; options: ScopedRecordsOptions }[] = [];
  const scopedSubscribeCalls: { contextId: string; module: string; selection: string | readonly string[] }[] = [];
  const unscopedSubscribeCalls: { module: string; selection: string | readonly string[] }[] = [];
  let seq = 0;

  const state = {
    rows,
    sources,
    ensureReadyCalls,
    followSourceCalls,
    ensureModulesCalls,
    scopeCalls,
    scopedSubscribeCalls,
    unscopedSubscribeCalls,
    resolveGraphOverride: undefined as
      | ((source: FollowedSyncSource, moduleUri: string) => Promise<ResolvedModuleGraph>)
      | undefined,
    emitSync(event: SyncEvent): void {
      for (const listener of [...syncListeners]) {
        listener(event);
      }
    },
    abortSession(): void {
      sessionController.abort(new Error('session closed'));
    },
    enbox: undefined as unknown as EnboxHost,
  };

  const toRecord = (row: StoredRow): ContextRecord<unknown> => ({
    id: row.id,
    author: row.creator,
    creator: row.creator,
    contextId: row.contextId,
    module: row.module,
    modulePath: row.modulePath,
    recipient: row.recipient,
    timestamp: row.timestamp,
    dateCreated: row.timestamp,
    deleted: false,
    squash: false,
    audienceKeyDelivery: { state: 'delivered' },
    data: {
      blob: async () => new Blob([JSON.stringify(row.data)]),
      bytes: async () => new TextEncoder().encode(JSON.stringify(row.data)),
      json: async () => row.data,
      stream: async () => new ReadableStream(),
      text: async () => JSON.stringify(row.data),
      then: () => Promise.resolve(new ReadableStream()),
      catch: () => Promise.resolve(new ReadableStream()),
    },
    value: async () => row.data,
    delete: async () => {
      const idx = rows.indexOf(row);
      if (idx >= 0) {
        rows.splice(idx, 1);
      }
    },
    update: async (params) => {
      if (params.data !== undefined) {
        row.data = params.data;
      }
      row.timestamp = `2026-11-10T00:00:${String(++seq).padStart(2, '0')}.000000Z`;
      return toRecord(row);
    },
  });

  const makePage = <T>(items: T[]): RecordPage<T> => ({
    records: items,
    next: async () => undefined,
    async *[Symbol.asyncIterator](): AsyncIterator<T> {
      for (const item of items) {
        yield item;
      }
    },
  });

  const makeView = <T>(getItems: () => T[]): ExpandableRecordView<T> => {
    const viewState = (): RecordViewState<T> =>
      Object.freeze({
        status: 'ready',
        current: true,
        hasMore: false,
        records: Object.freeze(getItems()),
      });
    return {
      getSnapshot: viewState,
      subscribe: () => () => {},
      ready: async () => viewState() as Extract<RecordViewState<T>, { status: 'ready' }>,
      refresh: async () => viewState() as Extract<RecordViewState<T>, { status: 'ready' }>,
      loadMore: async () => {},
      close: async () => {},
    };
  };

  const dwn: HostDwnApi = {
    connectedDid,
    records: {
      query: async ({ filter }) => ({
        status: { code: 200, detail: 'OK' },
        records: rows
          .filter(
            r =>
              (filter.module === undefined || r.module === filter.module)
              && (filter.modulePath === undefined || r.modulePath === filter.modulePath)
              && (filter.contextId === undefined
                || r.contextId === filter.contextId
                || r.contextId.startsWith(`${filter.contextId}/`)),
          )
          .map(r => ({
            id: r.id,
            contextId: r.contextId,
            creator: r.creator,
            recipient: r.recipient,
            module: r.module,
            modulePath: r.modulePath,
            timestamp: r.timestamp,
            deleted: false,
          })),
      }),
      delete: async ({ recordId }) => {
        const idx = rows.findIndex(r => r.id === recordId);
        if (idx >= 0) {
          rows.splice(idx, 1);
        }
        return { status: { code: 202, detail: 'Accepted' } };
      },
    },
    withRecordExecutionContext: () => dwn,
  };

  const typedCache = new Map<object, TypedEnboxHost>();
  const makeScopeRecords = (mod: TypedModule, options: ScopedRecordsOptions): ContextRecordsApi => {
    const checkPath = async (path: string): Promise<void> => {
      await options.prepare?.(path);
      const allowed = typeof options.allowedPaths === 'function' ? options.allowedPaths() : options.allowedPaths;
      if (!allowed.has(path)) {
        throw new TypeError(`Context-bound records do not expose path '${path}'.`);
      }
    };
    return {
      create: async (path, req) => {
        await checkPath(path);
        const id = `rec-${++seq}`;
        const row: StoredRow = {
          id,
          module: mod.definition.module,
          modulePath: path,
          contextId: `${options.contextId}/${id}`,
          creator: connectedDid,
          recipient: req.recipient,
          timestamp: req.messageTimestamp ?? `2026-11-10T00:00:${String(seq).padStart(2, '0')}.000000Z`,
          data: req.data,
        };
        rows.push(row);
        return toRecord(row) as never;
      },
      query: async (...args: unknown[]) => {
        const path = args[0] as string;
        await checkPath(path);
        const matching = rows
          .filter(r => r.module === mod.definition.module && r.modulePath === path)
          .map(toRecord);
        return makePage(matching) as never;
      },
      observe: async (path: string) => {
        await checkPath(path);
        return makeView(() =>
          rows.filter(r => r.module === mod.definition.module && r.modulePath === path).map(toRecord),
        ) as never;
      },
      subscribe: (async (...args: unknown[]) => {
        const selection = args[0] as string | readonly string[];
        scopedSubscribeCalls.push({ contextId: options.contextId, module: mod.definition.module, selection });
        return { close: async () => {} };
      }) as ContextRecordsApi['subscribe'],
      count: async (path) => {
        await checkPath(path);
        return rows.filter(r => r.module === mod.definition.module && r.modulePath === path).length;
      },
      read: async (path, idOrReq) => {
        await checkPath(path);
        const id = typeof idOrReq === 'string' ? idOrReq : idOrReq.filter.recordId;
        const found = rows.find(r => r.id === id && r.module === mod.definition.module);
        return (found === undefined ? undefined : toRecord(found)) as never;
      },
      patch: async (path, recordId) => {
        await checkPath(path);
        const found = rows.find(r => r.id === recordId)!;
        return toRecord(found) as never;
      },
      set: async (path, req) => {
        await checkPath(path);
        const id = `rec-${++seq}`;
        const row: StoredRow = {
          id,
          module: mod.definition.module,
          modulePath: path,
          contextId: `${options.contextId}/${id}`,
          creator: connectedDid,
          timestamp: `2026-11-10T00:00:${String(seq).padStart(2, '0')}.000000Z`,
          data: req.data,
        };
        rows.push(row);
        return toRecord(row) as never;
      },
      delete: async (path, req) => {
        await checkPath(path);
        const idx = rows.findIndex(r => r.id === req.recordId);
        if (idx >= 0) {
          rows.splice(idx, 1);
        }
      },
    };
  };

  const sync: SyncEngineHost = {
    followSource: async (opts) => {
      followSourceCalls.push({ modules: opts.modules ?? [] });
      const id = `src-${opts.sourceDid}-${opts.contextId}`;
      const existing = sources.get(id);
      if (existing !== undefined) {
        return existing;
      }
      const created: FollowedSyncSource = {
        id,
        acceptanceId: `acc-${++seq}`,
        actorDid: opts.actorDid,
        sourceDid: opts.sourceDid,
        rootModule: opts.rootModule,
        contextId: opts.contextId,
        roles: opts.roles,
        remoteEndpoint: 'https://dwn.owner.example',
        modules: {
          [opts.rootModule]: {
            contextPath: opts.contextPath,
            moduleRole: opts.roles[0]!,
            modulePaths: [opts.contextPath, `${opts.contextPath}/title`],
          },
          ...Object.fromEntries(
            (opts.modules ?? []).map(uri => [
              uri,
              {
                contextPath: 'page',
                moduleRole: `core:${opts.roles[0]!}`,
                modulePaths: ['page/live'],
              },
            ]),
          ),
        },
      };
      sources.set(id, created);
      return created;
    },
    ensureFollowedSourceModules: async (src, modules) => {
      ensureModulesCalls.push({ modules });
      return src;
    },
    resolveFollowedSourceModuleGraph: async (src, moduleUri) => {
      if (state.resolveGraphOverride !== undefined) {
        return state.resolveGraphOverride(src, moduleUri);
      }
      if (moduleUri === RealtimeModule.definition.module) {
        return buildTestGraph(RealtimeModule);
      }
      return buildTestGraph(NotebookModule);
    },
    getFollowedSource: async id => sources.get(id),
    listFollowedSources: async () => [...sources.values()],
    deleteFollowedSource: async (src) => {
      sources.delete(src.id);
    },
    pullFollowedSource: async () => true,
    markFollowedSourcePullPending: async () => {},
    on: (listener) => {
      syncListeners.add(listener);
      return () => syncListeners.delete(listener);
    },
  };

  state.enbox = {
    connectedDid,
    signal: sessionController.signal,
    dwn,
    agent: { sync },
    using: <D extends ModuleDefinition, C extends Record<string, RecordCodec<unknown>>>(
      mod: TypedModule<D, C>,
    ): TypedEnboxHost<D, C> => {
      const cached = typedCache.get(mod);
      if (cached !== undefined) {
        return cached as unknown as TypedEnboxHost<D, C>;
      }
      const graph = buildTestGraph(mod);
      const instance: TypedEnboxHost = {
        module: mod.definition.module,
        definition: mod.definition,
        graph,
        dwn,
        roleDelivery: {
          get: async () => ({ state: 'delivered' }),
          retry: async () => ({ state: 'delivered' }),
          subscribe: () => () => {},
        },
        ensureReady: async (path: string) => {
          ensureReadyCalls.push({ module: mod.definition.module, path });
        },
        scope: (options) => {
          scopeCalls.push({ module: mod.definition.module, options });
          return makeScopeRecords(mod, options) as never;
        },
        records: {
          create: async (path, req) => {
            const id = `rec-${++seq}`;
            const parent = req.parentContextId;
            const row: StoredRow = {
              id,
              module: mod.definition.module,
              modulePath: path,
              contextId: parent ? `${parent}/${id}` : id,
              creator: connectedDid,
              recipient: req.recipient,
              timestamp: req.messageTimestamp ?? `2026-11-10T00:00:${String(seq).padStart(2, '0')}.000000Z`,
              data: req.data,
            };
            rows.push(row);
            return toRecord(row) as never;
          },
          query: async (path, req) => {
            const matching = rows
              .filter(
                r =>
                  r.module === mod.definition.module
                  && r.modulePath === path
                  && (req?.within === undefined || r.contextId.startsWith(`${req.within}/`))
                  && (req?.filter?.recipient === undefined || r.recipient === req.filter.recipient),
              )
              .sort((a, b) =>
                req?.dateSort === 'createdDescending'
                  ? b.timestamp.localeCompare(a.timestamp)
                  : a.timestamp.localeCompare(b.timestamp),
              )
              .map(toRecord);
            return makePage(matching) as never;
          },
          observe: async (path, req) => {
            return makeView(() =>
              rows
                .filter(
                  r =>
                    r.module === mod.definition.module
                    && r.modulePath === path
                    && (req?.within === undefined || r.contextId.startsWith(`${req.within}/`))
                    && (req?.filter?.recipient === undefined || r.recipient === req.filter.recipient),
                )
                .map(toRecord),
            ) as never;
          },
          subscribe: async (selection: string | readonly string[]) => {
            unscopedSubscribeCalls.push({ module: mod.definition.module, selection });
            return { close: async () => {} };
          },
          delete: async (_path, req) => {
            const idx = rows.findIndex(r => r.id === req.recordId);
            if (idx >= 0) {
              rows.splice(idx, 1);
            }
          },
        },
      };
      typedCache.set(mod, instance);
      return instance as unknown as TypedEnboxHost<D, C>;
    },
  };

  return state;
}

describe('bindContexts & ContextFollowing end-to-end contracts', () => {
  it('shares one ContextFollowing coordinator across base and withModules() handles while keeping withModules() inert', async () => {
    const host = createTestEnboxHost(MEMBER_DID);
    const baseContexts = bindContexts(host.enbox, NotebookContextsModule);
    const extendedContexts = baseContexts.withModules({ realtime: RealtimeModule });

    // Simply creating extendedContexts must NOT trigger baseContexts.follow to request RealtimeModule!
    await baseContexts.follow('notebook/page', { ownerDid: OWNER_DID, id: 'nb1/pg1' });
    expect(host.followSourceCalls[0]?.modules).toEqual([]);

    // Concurrent forget on baseContexts + follow on extendedContexts serialize cleanly on one journal
    await Promise.all([
      baseContexts.forget({ ownerDid: OWNER_DID, id: 'nb1/pg1' }),
      extendedContexts.follow('notebook/page', { ownerDid: OWNER_DID, id: 'nb1/pg1' }),
    ]);

    const journalRows = host.rows.filter(
      r => r.module === NotebookContextsModule.definition.module && r.modulePath === CONTEXT_FOLLOW_PATH,
    );
    // Initial follow (true) -> forget (false) -> re-follow (true), strictly ordered!
    expect(journalRows.map(r => (r.data as { following: boolean }).following)).toEqual([true, false, true]);
    expect(host.ensureModulesCalls.some(call => call.modules.includes(RealtimeModule.definition.module))).toBe(true);
  });

  it('validates owned consumer paths BEFORE ensureReady, manages members, and delivers/accepts companion invitations', async () => {
    const ownerHost = createTestEnboxHost(OWNER_DID);
    const ownerContexts = bindContexts(ownerHost.enbox, NotebookContextsModule).withModules({
      realtime: RealtimeModule,
    });

    const ownedPage = await ownerContexts.open('notebook/page', 'nb1/pg1');
    const ownedRealtime = ownedPage.using(RealtimeModule);

    ownerHost.ensureReadyCalls.length = 0;
    // Invalid path throws TypeError BEFORE calling consumer ensureReady!
    await expect(
      (ownedRealtime.records.read as (path: string, id: string) => Promise<unknown>)('page/nonexistent', 'r1'),
    ).rejects.toThrow(TypeError);
    expect(ownerHost.ensureReadyCalls).toEqual([]);

    // Valid consumer write calls ensureReady and writes record
    await ownedRealtime.records.set('page/live', { data: { relay: 'wss://nostr-1.fly.dev' } });
    expect(ownerHost.ensureReadyCalls).toEqual([
      { module: RealtimeModule.definition.module, path: 'page/live' },
    ]);

    // Owner sets membership and sends invitation to companion module
    const aliceMember = await ownedPage.members.set(MEMBER_DID, {
      role: 'notebook/page/member',
      data: { name: 'Member' },
    });
    expect(aliceMember).toEqual({
      did: MEMBER_DID,
      role: 'notebook/page/member',
      data: { name: 'Member' },
      delivery: { state: 'delivered' },
    });
    expect(await ownedPage.members.list()).toHaveLength(1);

    await ownedPage.invite(MEMBER_DID, { preview: { title: 'Shared Page' } });
    const inviteRow = ownerHost.rows.find(
      r => r.module === NotebookContextsModule.definition.module && r.modulePath === CONTEXT_INVITATION_PATH,
    );
    expect(inviteRow).toBeDefined();

    // Transfer invitation row to member inbox and accept
    const memberHost = createTestEnboxHost(MEMBER_DID);
    memberHost.rows.push({ ...inviteRow! });
    const memberContexts = bindContexts(memberHost.enbox, NotebookContextsModule).withModules({
      realtime: RealtimeModule,
    });

    const invitations = await memberContexts.invitations.list();
    expect(invitations).toHaveLength(1);
    expect(invitations[0]).toMatchObject({
      ownerDid: OWNER_DID,
      contextId: 'nb1/pg1',
      path: 'notebook/page',
      preview: { title: 'Shared Page' },
    });

    const accepted = await invitations[0]!.accept();
    expect(accepted.access).toBe('member');
    expect(accepted.id).toBe('nb1/pg1');
    // Inbox cleaned up after accept
    expect(await memberContexts.invitations.list()).toHaveLength(0);

    // Leave withdraws role and saves forget decision
    await accepted.leave();
    expect(await memberContexts.list()).toEqual([]);
  });

  it('handles viewer role with zero consumer read paths, upfront observe validation, and onCapture error classification', async () => {
    const memberHost = createTestEnboxHost(MEMBER_DID);
    const viewerSource: FollowedSyncSource = {
      id: 'viewer-role-1',
      acceptanceId: 'acc-viewer',
      actorDid: MEMBER_DID,
      sourceDid: OWNER_DID,
      rootModule: NotebookModule.definition.module,
      contextId: 'nb1/pg1',
      roles: ['notebook/page/viewer'],
      remoteEndpoint: 'https://dwn.owner.example',
      modules: {
        [NotebookModule.definition.module]: {
          contextPath: 'notebook/page',
          moduleRole: 'notebook/page/viewer',
          modulePaths: ['notebook/page', 'notebook/page/title'],
        },
        [RealtimeModule.definition.module]: null,
      },
    };
    memberHost.sources.set(viewerSource.id, viewerSource);

    const contexts = bindContexts(memberHost.enbox, NotebookContextsModule).withModules({
      realtime: RealtimeModule,
    });
    const catalog = await contexts.list();
    expect(catalog).toHaveLength(1);
    const shared = catalog[0]!;
    expect(shared.access).toBe('member');

    // using(RealtimeModule) does NOT crash synchronously with TypeError even though `viewer` has 0 readable paths in RealtimeModule!
    const realtime = shared.using(RealtimeModule);
    expect(realtime.path).toBe('page');
    await expect(realtime.records.read('page/live', 'rec-1')).rejects.toBeInstanceOf(ContextNotReadyError);

    // Async observe validates path, pagination.limit, and within upfront before opening ProjectedRecordView
    await expect(
      (realtime.records.observe as (p: string, r: unknown) => Promise<unknown>)('page/bad', { pagination: { limit: 1 } }),
    ).rejects.toThrow(TypeError);
    await expect(
      realtime.records.observe('page/live', { pagination: { limit: 0 } }),
    ).rejects.toThrow('positive safe integer');
    await expect(
      realtime.records.observe('page/live', { pagination: { limit: 1 }, within: 'other/ctx' }),
    ).rejects.toThrow('cannot escape their context');

    // FollowedSourceNotReadyError in resolveFollowedSourceModuleGraph wraps as ContextNotReadyError,
    // while attachment path mismatch throws terminal Error (not ContextNotReadyError).
    const memberSourceWithScope: FollowedSyncSource = {
      ...viewerSource,
      id: 'member-role-2',
      roles: ['notebook/page/member'],
      modules: {
        [NotebookModule.definition.module]: {
          contextPath: 'notebook/page',
          moduleRole: 'notebook/page/member',
          modulePaths: ['notebook/page', 'notebook/page/title'],
        },
        [RealtimeModule.definition.module]: {
          contextPath: 'page',
          moduleRole: 'core:notebook/page/member',
          modulePaths: ['page/live'],
        },
      },
    };
    memberHost.sources.clear();
    memberHost.sources.set(memberSourceWithScope.id, memberSourceWithScope);

    const notReadyErr = new Error('graph support still downloading');
    notReadyErr.name = 'FollowedSourceNotReadyError';
    memberHost.resolveGraphOverride = async () => {
      throw notReadyErr;
    };

    const [memberCtx] = await contexts.list();
    const memberRealtime = memberCtx!.using(RealtimeModule);
    await expect(memberRealtime.records.read('page/live', 'rec-1')).rejects.toBeInstanceOf(ContextNotReadyError);

    // Now simulate mismatched attachment contextPath -> terminal Error (NOT ContextNotReadyError)
    const mismatchedSource: FollowedSyncSource = {
      ...memberSourceWithScope,
      acceptanceId: 'acc-mismatch',
      modules: {
        ...memberSourceWithScope.modules,
        [RealtimeModule.definition.module]: {
          contextPath: 'wrongMount',
          moduleRole: 'core:notebook/page/member',
          modulePaths: ['wrongMount/live'],
        },
      },
    };
    memberHost.sources.set(mismatchedSource.id, mismatchedSource);
    const [mismatchedCtx] = await contexts.list();
    const mismatchedRealtime = mismatchedCtx!.using(RealtimeModule);
    const mismatchErr = await mismatchedRealtime.records.read('page/live', 'rec-1').catch((e: unknown) => e);
    expect(mismatchErr).toBeInstanceOf(Error);
    expect(mismatchErr).not.toBeInstanceOf(ContextNotReadyError);
    expect((mismatchErr as Error).message).toContain('attachment path differs');
  });

  it('binds and follows a consumer module that attaches $ref to a descendant record beneath the shared root', async () => {
    const SharedWorkspaceModule = makeModule(
      {
        module: 'https://example.com/modules/workspace/v1',
        published: true,
        types: {
          workspace: { dataFormats: ['application/json'] },
          member: { dataFormats: ['application/json'] },
          doc: { dataFormats: ['application/json'], encryptionRequired: true },
        },
        structure: {
          workspace: {
            $actions: [{ role: 'workspace/member', can: ['read'] }],
            member: { $role: true },
            doc: { $actions: [{ role: 'workspace/member', can: ['create', 'read'] }] },
          },
        },
      },
      {
        workspace: jsonCodec<{ name: string }>(),
        member: jsonCodec<{ label: string }>(),
        doc: jsonCodec<{ title: string }>(),
      },
    );
    const DocCommentsModule = makeModule(
      {
        module: 'https://example.com/modules/workspace/comments/v1',
        published: true,
        uses: { ws: 'https://example.com/modules/workspace/v1' },
        types: {
          comment: { dataFormats: ['application/json'], encryptionRequired: true },
        },
        structure: {
          doc: {
            $ref: 'ws:workspace/doc',
            comment: {
              $actions: [{ role: 'ws:workspace/member', can: ['create', 'read'] }],
            },
          },
        },
      },
      { comment: jsonCodec<{ body: string }>() },
      { ws: SharedWorkspaceModule },
    );
    const WorkspaceContexts = defineContextModule(SharedWorkspaceModule);

    const ownerHost = createTestEnboxHost(OWNER_DID);
    const ownerContexts = bindContexts(ownerHost.enbox, WorkspaceContexts).withModules({ comments: DocCommentsModule });
    const owned = await ownerContexts.open('workspace', 'ws1');
    const ownerComments = owned.using(DocCommentsModule);
    expect(ownerComments.path).toBe('doc');
    await ownerComments.records.create('doc/comment', {
      data: { body: 'Owner comment' },
      parentContextId: 'ws1/doc1',
    });

    const memberHost = createTestEnboxHost(MEMBER_DID);
    const memberContexts = bindContexts(memberHost.enbox, WorkspaceContexts).withModules({ comments: DocCommentsModule });
    const followed = await memberContexts.follow('workspace', { ownerDid: OWNER_DID, id: 'ws1' });
    expect(memberHost.followSourceCalls[0]?.modules).toEqual([DocCommentsModule.definition.module]);
    const memberComments = followed.using(DocCommentsModule);
    expect(memberComments.path).toBe('doc');
  });

  it('binds explicit execution context on OwnedContext.records and scopes additional-role member wake subscriptions', async () => {
    const ownerHost = createTestEnboxHost(OWNER_DID);
    const ownerContexts = bindContexts(ownerHost.enbox, NotebookContextsModule);
    const owned = await ownerContexts.open('notebook/page', 'nb1/page1');

    const rootScopes = ownerHost.scopeCalls.filter(call => call.module === NotebookModule.definition.module);
    expect(rootScopes).toHaveLength(2);
    for (const scopeCall of rootScopes) {
      expect(scopeCall.options.contextId).toBe('nb1/page1');
      expect(scopeCall.options.execution).toMatchObject({
        contextId: 'nb1/page1',
        tenantDid: OWNER_DID,
      });
    }

    const memberView = await owned.members.observe();
    try {
      expect(ownerHost.scopedSubscribeCalls).toEqual([
        {
          contextId: 'nb1/page1',
          module: NotebookModule.definition.module,
          selection: ['notebook/page/viewer'],
        },
      ]);
      expect(ownerHost.unscopedSubscribeCalls.filter(call => call.module === NotebookModule.definition.module)).toEqual([]);
    } finally {
      await memberView.close();
    }
  });
});
