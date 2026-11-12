import type {
  ContextCompanionCodecs,
  ContextCompanionDefinition,
  ContextCompanionModule,
  ContextFollowIntent,
  ContextInvitationEnvelope,
  ContextInvitationPreview,
} from './companion-module.js';
import type { ContextView } from './context-view.js';
import type { ContextFollowRecord } from './following.js';
import type {
  AudienceKeyDeliveryOutcome,
  ContextFollowTarget,
  ContextInvitation,
  ContextMaterializedRecord,
  ContextMember,
  ContextMembersApi,
  ContextModuleBinding,
  ContextObserveRequest,
  ContextRecord,
  ContextRecordsApi,
  ContextsApi,
  EnboxHost,
  ExpandableRecordView,
  FollowedModuleScope,
  FollowedSyncSource,
  MemberContext,
  ModuleContext,
  ModuleDefinition,
  ModulePaths,
  OwnedContext,
  RecordCodecMap,
  RecordView,
  RecordViewState,
  ResolvedModuleGraph,
  ResolvedModuleNode,
  ResolvedModuleRoleScope,
  ResolvedRoleReference,
  RoleDeliveryState,
  SyncEngineHost,
  TypedEnboxHost,
  TypedModule,
} from './host-types.js';
import type { ProjectionViewGeneration } from './projected-record-view.js';

import {
  compareCodeUnits,
  compareRecordsNewestFirst,
  CONTEXT_FOLLOW_PATH,
  CONTEXT_INVITATION_PATH,
  currentTimestamp,
  isCanonicalModulePath,
  isContextCompanionModule,
  isPlainObject,
  isTypedModuleLike,
  isValidContextId,
  isValidDidUri,
  moduleContextKey,
  timestampAfter,
} from './companion-module.js';
import { createContextView, createMaterializedMemberContextView } from './context-view.js';
import {
  ContextNotReadyError,
  ContextRetiredError,
  isContextRetiredError,
  isFollowedSourceNotReadyError,
  isRecordValidationError,
} from './errors.js';
import { ContextFollowing } from './following.js';
import { FollowedModuleLease, followedSyncSourceActiveEqual } from './lease.js';
import {
  findModuleContextRoot,
  matchesSubtree,
  recordRepresentationsEqual,
  resolveModuleContextRoles,
  resolveModuleContextRoot,
  resolveModuleRoleScope,
} from './module-scope.js';
import { ObservedView, openView, toRecordViewErrorState, whileSignalsActive } from './observed-view.js';
import { createProjectedRecordView } from './projected-record-view.js';

const DEFAULT_INVITATION_LIMIT = 100;
const FOLLOW_PAGE_LIMIT = 100;
const MEMBER_ROLE_PAGE_LIMIT = 200;

type SharedSessionRegistryEntry = {
  following?: ContextFollowing;
  bindings: {
    modules: Readonly<Record<string, TypedModule>>;
    contexts: ContextsApi;
  }[];
};

const sessionRegistries = new WeakMap<object, WeakMap<object, SharedSessionRegistryEntry>>();

/**
 * Bind managed shared contexts, invitations, role memberships, and cross-device
 * follow/forget journals for `companionModule.root` over an active `Enbox` session.
 */
export function bindContexts<
  D extends ModuleDefinition,
  C extends RecordCodecMap,
>(
  enbox: EnboxHost,
  companionModule: ContextCompanionModule<TypedModule<D, C>>,
): ContextsApi<D, C> {
  if (enbox === null || typeof enbox !== 'object') {
    throw new TypeError('bindContexts: expected an active Enbox instance.');
  }
  if (!isContextCompanionModule(companionModule)) {
    throw new TypeError('bindContexts: expected a companion module created with defineContextModule().');
  }
  enbox.signal.throwIfAborted();
  const registry = getRegistryEntry(enbox, companionModule);
  return getOrCreateBinding(enbox, companionModule, registry, Object.freeze({}));
}

function getRegistryEntry(
  enbox: EnboxHost,
  companionModule: ContextCompanionModule,
): SharedSessionRegistryEntry {
  let byCompanion = sessionRegistries.get(enbox);
  if (byCompanion === undefined) {
    byCompanion = new WeakMap();
    sessionRegistries.set(enbox, byCompanion);
  }
  let entry = byCompanion.get(companionModule);
  if (entry === undefined) {
    entry = { bindings: [] };
    byCompanion.set(companionModule, entry);
  }
  return entry;
}

function getOrCreateBinding<
  D extends ModuleDefinition,
  C extends RecordCodecMap,
>(
  enbox: EnboxHost,
  companionModule: ContextCompanionModule<TypedModule<D, C>>,
  registry: SharedSessionRegistryEntry,
  selectedModules: Readonly<Record<string, TypedModule>>,
): ContextsApi<D, C> {
  const names = Object.keys(selectedModules).sort(compareCodeUnits);
  const cached = registry.bindings.find(
    candidate =>
      Object.keys(candidate.modules).length === names.length
      && names.every(name => candidate.modules[name] === selectedModules[name]),
  );
  if (cached !== undefined) {
    return cached.contexts as unknown as ContextsApi<D, C>;
  }
  const contexts = createContextsInstance(enbox, companionModule, registry, selectedModules);
  registry.bindings.push({ modules: selectedModules, contexts: contexts as unknown as ContextsApi });
  return contexts;
}

function createContextsInstance<
  D extends ModuleDefinition,
  C extends RecordCodecMap,
>(
  enbox: EnboxHost,
  companionModule: ContextCompanionModule<TypedModule<D, C>>,
  registry: SharedSessionRegistryEntry,
  selectedModules: Readonly<Record<string, TypedModule>>,
): ContextsApi<D, C> {
  const rootModule = companionModule.root;
  const rootTyped = enbox.using(rootModule);
  const companionTyped = enbox.using(companionModule) as unknown as TypedEnboxHost<
    ContextCompanionDefinition,
    ContextCompanionCodecs
  >;
  const rootGraph = rootTyped.graph;
  const rootModuleUri = rootModule.definition.module;
  const companionModuleUri = companionModule.definition.module;

  const contextRolesByPath = new Map<string, readonly string[]>();
  const rolesForPath = (path: string): readonly string[] => {
    const cached = contextRolesByPath.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const resolved = getContextRoles(rootGraph, path);
    contextRolesByPath.set(path, resolved);
    return resolved;
  };

  const contextRoots = [...rootGraph.nodesByDeclaredPath.values()]
    .filter(node => node.kind === 'record' && node.ruleSet.$role !== true && node.owningModuleUri === rootModuleUri)
    .map(node => node.declaringModulePath)
    .filter(path => rolesForPath(path).length > 0);

  const hasContextModuleAttachment = (consumerGraph: ResolvedModuleGraph, root: ResolvedModuleNode): boolean =>
    root.kind === 'record'
    && root.ruleSet.$role !== true
    && root.owningModuleUri === rootModuleUri
    && findModuleContextRoot(consumerGraph, root) !== undefined;

  const attachesToAnyRoot = (consumerGraph: ResolvedModuleGraph): boolean => {
    for (const root of rootGraph.nodesByDeclaredPath.values()) {
      if (hasContextModuleAttachment(consumerGraph, root)) {
        return true;
      }
    }
    return false;
  };

  const contextModulesByPath = new Map<string, readonly string[]>();
  const contextModulesAt = (path: string): readonly string[] => {
    const cached = contextModulesByPath.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const root = rootGraph.nodesByDeclaredPath.get(path);
    const modules = root?.kind === 'record'
      ? Object.freeze(
        Object.values(selectedModules)
          .filter(module => hasContextModuleAttachment(enbox.using(module).graph, root))
          .map(module => module.definition.module),
      )
      : Object.freeze([]);
    contextModulesByPath.set(path, modules);
    return modules;
  };

  const canUseFollowing = enbox.agent.sync !== undefined;

  const readFollowRecord = async (
    record: ContextRecord<ContextFollowIntent>,
  ): Promise<ContextFollowRecord | undefined> => {
    if (
      record.creator !== enbox.connectedDid
      || record.module !== companionModuleUri
      || record.modulePath !== CONTEXT_FOLLOW_PATH
    ) {
      return undefined;
    }
    try {
      const value = await record.value();
      return { id: record.id, timestamp: record.timestamp, value };
    } catch (error: unknown) {
      if (isRecordValidationError(error)) {
        return undefined;
      }
      throw error;
    }
  };

  const getFollowing = (): ContextFollowing => {
    const sync = enbox.agent.sync;
    if (sync === undefined) {
      throw new TypeError('ContextsApi requires an Enbox session with sync storage.');
    }
    registry.following ??= new ContextFollowing({
      actorDid: enbox.connectedDid,
      companionModuleUri,
      rootModuleUri,
      rootGraph,
      signal: enbox.signal,
      sync,
      append: async (intent: ContextFollowIntent, after?: string): Promise<ContextFollowRecord> => {
        const timestamp = after === undefined ? currentTimestamp() : timestampAfter(after);
        const created = await companionTyped.records.create(CONTEXT_FOLLOW_PATH, {
          data: intent,
          dateCreated: timestamp,
          messageTimestamp: timestamp,
        });
        return { id: created.id, timestamp: created.timestamp, value: intent };
      },
      read: async (): Promise<readonly ContextFollowRecord[]> => {
        const page = await companionTyped.records.query(CONTEXT_FOLLOW_PATH, {
          dateSort: 'createdAscending',
          pagination: { limit: FOLLOW_PAGE_LIMIT },
        });
        const rows: ContextFollowRecord[] = [];
        for await (const record of page) {
          const decoded = await readFollowRecord(record);
          if (decoded !== undefined) {
            rows.push(decoded);
          }
        }
        return rows;
      },
      openView: (signal: AbortSignal) =>
        companionTyped.records.observe(CONTEXT_FOLLOW_PATH, {
          dateSort: 'createdAscending',
          pagination: { limit: FOLLOW_PAGE_LIMIT },
          signal,
        }),
      decodeRecord: readFollowRecord,
    });
    return registry.following;
  };

  const listSources = async (): Promise<FollowedSyncSource[]> => {
    const sync = enbox.agent.sync;
    if (sync === undefined) {
      return [];
    }
    const sources = await sync.listFollowedSources();
    enbox.signal.throwIfAborted();
    return sources.filter(
      source => source.actorDid === enbox.connectedDid && source.rootModule === rootModuleUri,
    );
  };

  const boundOwners = new Map<string, OwnedContext<D, C>>();
  const boundMembers = new Map<string, { context: MemberContext<D, C>; source: FollowedSyncSource }>();

  const createContextModuleAccessor = <Root extends string>(
    rootPath: Root,
    contextId: string,
    source?: FollowedSyncSource,
    contextSignal: AbortSignal = enbox.signal,
    rootLease?: FollowedModuleLease,
  ): (<M extends TypedModule>(module: M) => ContextModuleBinding<M, D['module'], Root>) => {
    type CachedBinding = {
      binding: ContextModuleBinding;
      innerRecords: ContextModuleBinding['records'];
      signal: AbortSignal;
    };
    const bindings = new Map<TypedModule, CachedBinding>();
    const selectedValues = Object.values(selectedModules);

    const getBinding = (consumerModule: TypedModule): CachedBinding => {
      enbox.signal.throwIfAborted();
      contextSignal.throwIfAborted();
      if (!selectedValues.includes(consumerModule)) {
        throw new TypeError('Context.using requires a consumer explicitly selected with contexts.withModules().');
      }
      const existing = bindings.get(consumerModule);
      if (existing !== undefined && !existing.signal.aborted) {
        return existing;
      }

      const consumerTyped = enbox.using(consumerModule);
      const consumerGraph = consumerTyped.graph;
      const rootNode = resolveRecordNode(rootGraph, rootPath);
      const attachment = resolveModuleContextRoot(consumerGraph, rootNode);
      const attachmentPath = attachment.declaringModulePath;
      const staticConsumerPaths = collectSubtreeRecordPaths(consumerGraph, attachmentPath, false);

      let innerRecords: ContextModuleBinding['records'];
      let publicRecords: ContextModuleBinding['records'];
      let bindingSignal = contextSignal;

      if (source === undefined) {
        innerRecords = consumerTyped.scope({
          allowedPaths: staticConsumerPaths,
          contextId,
          contextPath: attachmentPath,
          execution: {
            assertActive: async (): Promise<void> => {
              contextSignal.throwIfAborted();
            },
            contextId,
            tenantDid: enbox.connectedDid,
          },
          prepare: async (path: string): Promise<void> => {
            if (!staticConsumerPaths.has(path)) {
              throw new TypeError(`Context-bound records do not expose path '${path}'.`);
            }
            await consumerTyped.ensureReady(path);
          },
          signal: contextSignal,
        }) as unknown as ContextModuleBinding['records'];
        publicRecords = innerRecords;
      } else {
        const sync = enbox.agent.sync!;
        const rootRoleRef = rootGraph.resolveInvokedRole(source.modules[source.rootModule]!.moduleRole);
        // If the member's root role grants zero readable paths in this optional consumer,
        // resolveRoleScope throws TypeError; treat permittedPaths as empty so using() stays inert
        // and operations reject with ContextNotReadyError unless the role/scope changes.
        let initialScope: ResolvedModuleRoleScope | undefined;
        try {
          initialScope = resolveModuleRoleScope(consumerGraph, rootRoleRef);
        } catch (error: unknown) {
          if (!(error instanceof TypeError)) {
            throw error;
          }
        }
        // Immutable reference swap via getter instead of mutating a shared Set in place.
        let permittedPaths: ReadonlySet<string> = initialScope === undefined
          ? new Set<string>()
          : new Set(initialScope.allowedPaths);

        const moduleLease = new FollowedModuleLease({
          root: rootLease,
          module: consumerModule.definition.module,
          source,
          signal: contextSignal,
          sync,
          onCapture: async (accepted, verifiedSource): Promise<void> => {
            permittedPaths = await verifyMemberConsumerCapture({
              accepted,
              attachmentPath,
              consumerGraph,
              consumerModuleUri: consumerModule.definition.module,
              initialScope,
              rootRoleRef,
              sync,
              verifiedSource,
            });
          },
        });

        bindingSignal = moduleLease.signal;
        innerRecords = consumerTyped.scope({
          allowedPaths: () => permittedPaths,
          contextId,
          contextPath: attachmentPath,
          execution: moduleLease.executionContext(),
          prepare: async (): Promise<void> => {
            await moduleLease.assertActive();
          },
          signal: bindingSignal,
        }) as unknown as ContextModuleBinding['records'];

        const observe = createProjectedConsumerObserve({
          bindingSignal,
          consumerModuleUri: consumerModule.definition.module,
          contextId,
          contextSignal,
          enboxSignal: enbox.signal,
          getGeneration: (path, request) => (): ProjectionViewGeneration<unknown> => {
            const current = getBinding(consumerModule);
            return {
              signal: current.signal,
              open: (viewSignal: AbortSignal): Promise<ExpandableRecordView<unknown>> =>
                current.innerRecords.observe(path, { ...request, signal: viewSignal }),
            };
          },
          rootLease: rootLease!,
          source,
          staticConsumerPaths,
          sync,
        });
        publicRecords = Object.freeze({ ...innerRecords, observe });
      }

      const binding: ContextModuleBinding = Object.freeze({
        module: consumerModule.definition.module,
        path: attachmentPath,
        records: publicRecords,
      });
      const cachedEntry: CachedBinding = { binding, innerRecords, signal: bindingSignal };
      bindings.set(consumerModule, cachedEntry);
      return cachedEntry;
    };

    return <M extends TypedModule>(module: M): ContextModuleBinding<M, D['module'], Root> =>
      getBinding(module).binding as unknown as ContextModuleBinding<M, D['module'], Root>;
  };

  const bindOwnedContext = <Root extends ModulePaths<D> & string>(
    path: Root,
    id: string,
  ): OwnedContext<D, C, Root> => {
    const key = moduleContextKey(enbox.connectedDid, id);
    const existing = boundOwners.get(key);
    if (existing !== undefined && existing.path === path) {
      return existing as unknown as OwnedContext<D, C, Root>;
    }
    const allowedPaths = collectSubtreeRecordPaths(rootGraph, path, true);
    const roles = rolesForPath(path);
    const base = {
      access: 'owner' as const,
      id,
      key,
      ownerDid: enbox.connectedDid,
      path,
      records: rootTyped.scope({
        allowedPaths,
        contextId: id,
        contextPath: path,
        signal: enbox.signal,
      }) as ContextRecordsApi<D, C, Root>,
      rootRecordId: contextRootRecordId(id),
      using: createContextModuleAccessor(path, id),
    };
    const owned = Object.freeze(
      roles.length === 0
        ? base
        : {
          ...base,
          invite: async (
            did: string,
            request?: Readonly<{ preview?: ContextInvitationPreview }>,
          ): Promise<void> => {
            const recipient = normalizeMemberDid(did);
            const preview = normalizeInvitationPreview(request?.preview);
            await companionTyped.ensureReady(CONTEXT_INVITATION_PATH);
            await companionTyped.records.create(CONTEXT_INVITATION_PATH, {
              data: { contextId: id, path, preview },
              from: recipient,
              recipient,
            });
          },
          members: createMembersApi(enbox, rootTyped, id, roles),
        },
    ) as unknown as OwnedContext<D, C, Root>;
    boundOwners.set(key, owned as unknown as OwnedContext<D, C>);
    return owned;
  };

  const bindMemberContext = (source: FollowedSyncSource): MemberContext<D, C> => {
    const key = moduleContextKey(source.sourceDid, source.contextId);
    const existing = boundMembers.get(key);
    if (existing !== undefined && followedSyncSourceActiveEqual(existing.source, source)) {
      return existing.context;
    }
    const sync = enbox.agent.sync;
    if (sync === undefined) {
      throw new Error('ContextsApi requires an Enbox session with sync storage.');
    }
    const rootScope = source.modules[source.rootModule]!;
    const scope = resolveModuleRoleScope(rootGraph, rootGraph.resolveInvokedRole(rootScope.moduleRole));
    const allowedPaths = filterReplicatedRolePaths(scope, rootScope.modulePaths);

    const lease = new FollowedModuleLease({
      module: rootModuleUri,
      source,
      sync,
      signal: enbox.signal,
    });
    const signal = lease.signal;
    const membershipDwn = enbox.dwn.withRecordExecutionContext(lease.executionContext(false));
    const withdrawRole = async (): Promise<void> => {
      const result = await membershipDwn.records.delete({
        contextId: source.contextId,
        module: source.rootModule,
        modulePath: rootScope.moduleRole,
        recordId: source.id,
      });
      if (result.status.code !== 404 && result.status.code !== 409 && (result.status.code < 200 || result.status.code >= 300)) {
        throw new Error(`MemberContext.leave failed (${result.status.code}): ${result.status.detail}`);
      }
    };
    const retire = async (withdraw?: () => Promise<void>): Promise<void> => {
      enbox.signal.throwIfAborted();
      await getFollowing().forget(source, withdraw);
      await lease.assertActive().catch((error: unknown): void => {
        if (!isContextRetiredError(error)) {
          throw error;
        }
      });
    };

    const member = Object.freeze({
      access: 'member' as const,
      forget: (): Promise<void> => retire(),
      id: source.contextId,
      key,
      leave: (): Promise<void> => retire(withdrawRole),
      ownerDid: source.sourceDid,
      path: scope.contextPath,
      records: rootTyped.scope({
        allowedPaths,
        contextId: source.contextId,
        contextPath: scope.contextPath,
        execution: lease.executionContext(),
        signal,
      }) as ContextRecordsApi<D, C, string>,
      refresh: (): Promise<void> => lease.refresh(),
      role: rootScope.moduleRole,
      rootRecordId: contextRootRecordId(source.contextId),
      using: createContextModuleAccessor(scope.contextPath, source.contextId, source, signal, lease),
    }) as unknown as MemberContext<D, C>;
    boundMembers.set(key, { context: member, source });
    return member;
  };

  const bindCatalogMembers = (sources: readonly FollowedSyncSource[]): MemberContext<D, C>[] => {
    const members = new Map<string, MemberContext<D, C>>();
    for (const source of sources) {
      const key = moduleContextKey(source.sourceDid, source.contextId);
      if (!members.has(key)) {
        members.set(key, bindMemberContext(source));
      }
    }
    for (const key of boundMembers.keys()) {
      if (!members.has(key)) {
        boundMembers.delete(key);
      }
    }
    return [...members.values()];
  };

  const listOwnedRootContextIds = async (path: string): Promise<string[]> => {
    await rootTyped.ensureReady(path);
    const node = resolveRecordNode(rootGraph, path);
    const steps = [...node.physicalAncestors, node];
    let parentContexts: Array<string | undefined> = [undefined];
    let contextIds: string[] = [];
    for (const step of steps) {
      const results = await Promise.all(
        parentContexts.map(async (within) => {
          const reply = await enbox.dwn.records.query({
            filter: {
              module: step.owningModuleUri,
              modulePath: step.owningModulePath,
              ...(within === undefined ? {} : { contextId: within }),
            },
          });
          if (reply.status.code < 200 || reply.status.code >= 300) {
            throw new Error(`ContextsApi.list failed (${reply.status.code}): ${reply.status.detail}`);
          }
          return reply.records;
        }),
      );
      contextIds = results.flat().map((record) => {
        if (record.contextId === undefined) {
          throw new Error(`ContextsApi.list: '${step.owningModulePath}' record is missing its context ID.`);
        }
        return record.contextId;
      });
      parentContexts = contextIds;
    }
    return contextIds;
  };

  const listCatalogContexts = async (): Promise<ModuleContext<D, C>[]> => {
    const [ownedByRoot, sources] = await Promise.all([
      Promise.all(
        contextRoots.map(async (path): Promise<ModuleContext<D, C>[]> =>
          (await listOwnedRootContextIds(path)).map(
            contextId => bindOwnedContext(path as ModulePaths<D> & string, contextId) as unknown as ModuleContext<D, C>,
          ),
        ),
      ),
      listSources(),
    ]);
    const contexts = new Map<string, ModuleContext<D, C>>(ownedByRoot.flat().map(ctx => [ctx.key, ctx]));
    for (const key of boundOwners.keys()) {
      if (!contexts.has(key)) {
        boundOwners.delete(key);
      }
    }
    for (const member of bindCatalogMembers(sources)) {
      if (!contexts.has(member.key)) {
        contexts.set(member.key, member as unknown as ModuleContext<D, C>);
      }
    }
    return [...contexts.values()].sort(compareModuleContexts);
  };

  const followContext = async (rawPath: string, request: ContextFollowTarget): Promise<MemberContext<D, C>> => {
    enbox.signal.throwIfAborted();
    const path = normalizePath(rawPath);
    const target = normalizeFollowTarget(request, 'ContextsApi.follow');
    if (rolesForPath(path).length === 0) {
      throw new TypeError(`ContextsApi.follow: '${path}' is not a shared context root.`);
    }
    let source: FollowedSyncSource;
    try {
      source = await getFollowing().follow({ ...target, path }, contextModulesAt);
    } catch (error: unknown) {
      if (isFollowedSourceNotReadyError(error)) {
        throw new ContextNotReadyError(error);
      }
      if (error instanceof ContextRetiredError || error instanceof TypeError) {
        throw error;
      }
      throw new Error('ContextsApi.follow: unable to verify and follow the requested context.', { cause: error });
    }
    return bindMemberContext(source);
  };

  const openCatalogWakeSubscription = async (
    wake: () => void,
    fail: (error: Error) => void,
    signal?: AbortSignal,
    includeOwnedRoots = true,
  ): Promise<{ close(): Promise<void> }> => {
    const detachSync = enbox.agent.sync?.on((event): void => {
      if (
        event.type === 'followed-context:change'
        && event.actorDid === enbox.connectedDid
        && event.module === rootModuleUri
      ) {
        wake();
      }
      registry.following?.retryAfterSync(event);
    }) ?? ((): void => {});

    let follows: { close(): Promise<void> } | undefined;
    try {
      if (canUseFollowing) {
        follows = await getFollowing().observe({
          additionalModules: contextModulesAt,
          onChange: wake,
          onError: fail,
          signal,
        });
      }
      const records = !includeOwnedRoots || contextRoots.length === 0
        ? undefined
        : await rootTyped.records.subscribe(
          contextRoots as (ModulePaths<D> & string)[],
          { signal },
          (event): void => {
            if (event.type === 'error') {
              fail(event.error);
            } else {
              wake();
            }
          },
        );
      return {
        close: async (): Promise<void> => {
          detachSync();
          const closed = await Promise.allSettled([records?.close(), follows?.close()]);
          const failed = closed.find((result): result is PromiseRejectedResult => result.status === 'rejected');
          if (failed !== undefined) {
            throw failed.reason;
          }
        },
      };
    } catch (error: unknown) {
      detachSync();
      await follows?.close().catch((): void => {});
      throw error;
    }
  };

  const withModules = (modules: Readonly<Record<string, TypedModule>>): ContextsApi<D, C> => {
    enbox.signal.throwIfAborted();
    if (!isPlainObject(modules)) {
      throw new TypeError('ContextsApi.withModules requires a named map of typed consumer modules.');
    }
    const merged = Object.freeze({ ...selectedModules, ...modules });
    const names = Object.keys(merged).sort(compareCodeUnits);
    if (names.length === 0) {
      return getOrCreateBinding(enbox, companionModule, registry, Object.freeze({}));
    }
    const uris = new Set<string>();
    for (const name of names) {
      const candidate = merged[name];
      if (!isTypedModuleLike(candidate)) {
        throw new TypeError(`ContextsApi.withModules: '${name}' is not a TypedModule.`);
      }
      if (candidate.definition.module === rootModuleUri || uris.has(candidate.definition.module)) {
        throw new TypeError('ContextsApi.withModules requires distinct consumer module URIs.');
      }
      uris.add(candidate.definition.module);
      const graph = enbox.using(candidate).graph;
      if (!attachesToAnyRoot(graph)) {
        throw new TypeError(
          `ContextsApi.withModules: '${candidate.definition.module}' does not attach to an owned root of '${rootModuleUri}'.`,
        );
      }
    }
    return getOrCreateBinding(enbox, companionModule, registry, merged);
  };

  const openContext = async <Root extends string>(rawPath: Root, id: string): Promise<OwnedContext<D, C, Root & ModulePaths<D>>> => {
    enbox.signal.throwIfAborted();
    const path = normalizePath(rawPath);
    const node = resolveRecordNode(rootGraph, path);
    if (node.ruleSet.$role === true) {
      throw new TypeError('ContextsApi.open cannot open a role record as a context.');
    }
    if (!isValidContextId(id) || id.split('/').length !== node.physicalDepth) {
      throw new TypeError(`ContextsApi.open: id must identify a '${path}' context.`);
    }
    await rootTyped.ensureReady(path);
    return bindOwnedContext(path as Root & ModulePaths<D>, id);
  };

  const projectInvitations = async (
    records: readonly ContextRecord<ContextInvitationEnvelope>[],
  ): Promise<ContextInvitation<MemberContext<D, C>, string>[]> => {
    type Candidate = {
      contextId: string;
      path: string;
      ownerDid: string;
      preview: ContextInvitationPreview;
      records: ContextRecord<ContextInvitationEnvelope>[];
      selected: ContextRecord<ContextInvitationEnvelope>;
    };
    const candidates = new Map<string, Candidate>();
    const decoded = await Promise.all(
      records.map(async (record): Promise<{
        envelope: ContextInvitationEnvelope;
        ownerDid: string;
        record: ContextRecord<ContextInvitationEnvelope>;
      } | undefined> => {
        if (
          record.recipient !== enbox.connectedDid
          || record.module !== companionModuleUri
          || record.modulePath !== CONTEXT_INVITATION_PATH
        ) {
          return undefined;
        }
        const ownerDid = record.creator.trim();
        if (!isValidDidUri(ownerDid)) {
          return undefined;
        }
        try {
          const envelope = await record.value();
          return { envelope, ownerDid, record };
        } catch (error: unknown) {
          if (isRecordValidationError(error)) {
            return undefined;
          }
          throw error;
        }
      }),
    );
    for (const item of decoded) {
      if (item === undefined) {
        continue;
      }
      const { envelope, ownerDid, record } = item;
      const rootNode = rootGraph.nodesByDeclaredPath.get(envelope.path);
      if (
        rootNode?.kind !== 'record'
        || rolesForPath(envelope.path).length === 0
        || !isValidContextId(envelope.contextId)
        || envelope.contextId.split('/').length !== rootNode.physicalDepth
      ) {
        continue;
      }
      const key = JSON.stringify([ownerDid, envelope.contextId, envelope.path]);
      const existing = candidates.get(key);
      if (existing === undefined) {
        candidates.set(key, {
          contextId: envelope.contextId,
          path: envelope.path,
          ownerDid,
          preview: Object.freeze({ ...envelope.preview }),
          records: [record],
          selected: record,
        });
      } else {
        existing.records.push(record);
        if (compareRecordsNewestFirst(record, existing.selected) < 0) {
          existing.preview = Object.freeze({ ...envelope.preview });
          existing.selected = record;
        }
      }
    }

    return [...candidates.values()]
      .sort((left, right) => compareRecordsNewestFirst(left.selected, right.selected))
      .map((candidate) => {
        let consumed = false;
        const dismiss = async (): Promise<void> => {
          if (consumed) {
            return;
          }
          await Promise.all(
            candidate.records.map(record =>
              companionTyped.records.delete(CONTEXT_INVITATION_PATH, { recordId: record.id }),
            ),
          );
          consumed = true;
        };
        return Object.freeze({
          id: candidate.selected.id,
          ownerDid: candidate.ownerDid,
          contextId: candidate.contextId,
          path: candidate.path,
          preview: candidate.preview,
          timestamp: candidate.selected.timestamp,
          dismiss,
          accept: async (): Promise<MemberContext<D, C>> => {
            if (consumed) {
              throw new Error('ContextInvitation: invitation is no longer pending.');
            }
            const context = await followContext(candidate.path, {
              id: candidate.contextId,
              ownerDid: candidate.ownerDid,
            });
            try {
              await dismiss();
            } catch {
              // Following is authoritative; inbox cleanup remains independently retryable.
            }
            return context;
          },
        });
      });
  };

  return Object.freeze({
    withModules,
    open: openContext,
    follow: followContext,
    forget: async (request: ContextFollowTarget): Promise<void> => {
      enbox.signal.throwIfAborted();
      const target = normalizeFollowTarget(request, 'ContextsApi.forget');
      await getFollowing().forgetContext(target);
    },
    ...(contextRoots.length > 0
      ? {
        invitations: Object.freeze({
          list: async (options?: Readonly<{ limit?: number }>): Promise<ContextInvitation<MemberContext<D, C>>[]> => {
            const limit = normalizeInvitationLimit(options?.limit);
            const page = await companionTyped.records.query(CONTEXT_INVITATION_PATH, {
              dateSort: 'createdDescending',
              filter: { recipient: enbox.connectedDid },
              pagination: { limit },
            });
            return projectInvitations(page.records);
          },
          observe: async (
            options?: Readonly<{ limit?: number; signal?: AbortSignal }>,
          ): Promise<RecordView<ContextInvitation<MemberContext<D, C>>>> => {
            const limit = normalizeInvitationLimit(options?.limit);
            return createMappedRecordView({
              callerSignal: options?.signal,
              sessionSignal: enbox.signal,
              openInner: (signal) =>
                companionTyped.records.observe(CONTEXT_INVITATION_PATH, {
                  dateSort: 'createdDescending',
                  filter: { recipient: enbox.connectedDid },
                  pagination: { limit },
                  signal,
                }),
              project: projectInvitations,
            });
          },
        }),
      }
      : {}),
    list: async (): Promise<ModuleContext<D, C>[]> => {
      if (canUseFollowing) {
        await getFollowing().restore(contextModulesAt);
      }
      return listCatalogContexts();
    },
    observe: async (options?: Readonly<{
      access?: 'member';
      materializeRoot?: true;
      signal?: AbortSignal;
    }>): Promise<ContextView<unknown>> => {
      if (options?.access !== undefined || options?.materializeRoot !== undefined) {
        if (options.access !== 'member' || options.materializeRoot !== true) {
          throw new TypeError(
            'ContextsApi.observe: root materialization requires access: \'member\' and materializeRoot: true.',
          );
        }
        return createMaterializedMemberContextView<MemberContext<D, C>, ContextMaterializedRecord<unknown>>({
          callerSignal: options.signal,
          getSavedFollows: () => registry.following?.getSavedFollows() ?? [],
          listContexts: async () => bindCatalogMembers(await listSources()).sort(compareModuleContexts),
          openRootView: (context, signal) =>
            (context.records.observe as unknown as (
              path: string,
              request: { materialize: true; pagination: { limit: number }; signal: AbortSignal },
            ) => Promise<RecordView<ContextMaterializedRecord<unknown>>>)(context.path, {
              materialize: true,
              pagination: { limit: 1 },
              signal,
            }),
          openWakeSubscription: (wake, fail) => openCatalogWakeSubscription(wake, fail, options.signal, false),
          signal: enbox.signal,
        });
      }
      return createContextView({
        callerSignal: options?.signal,
        getSavedFollows: () => registry.following?.getSavedFollows() ?? [],
        list: listCatalogContexts,
        openWakeSubscription: (wake, fail) => openCatalogWakeSubscription(wake, fail, options?.signal),
        signal: enbox.signal,
      });
    },
  }) as unknown as ContextsApi<D, C>;
}

function createMembersApi<
  D extends ModuleDefinition,
  C extends RecordCodecMap,
>(
  enbox: EnboxHost,
  rootTyped: TypedEnboxHost,
  contextId: string,
  selectedRoles: readonly string[],
): ContextMembersApi<D, C, ModulePaths<D> & string> {
  type RolePath = ModulePaths<D> & string;
  type ActiveMemberRecord = {
    did: string;
    record: ContextRecord<unknown>;
    role: RolePath;
  };
  const rolePaths = [...selectedRoles] as RolePath[];

  const loadRole = async (role: RolePath, did?: string): Promise<ActiveMemberRecord[]> => {
    const rows: ActiveMemberRecord[] = [];
    const page = await rootTyped.records.query(role, {
      within: contextId,
      pagination: { limit: MEMBER_ROLE_PAGE_LIMIT },
      ...(did === undefined ? {} : { filter: { recipient: did } }),
    });
    for await (const record of page) {
      if (typeof record.recipient === 'string' && record.recipient.length > 0) {
        rows.push({ did: record.recipient, record, role });
      }
    }
    return rows;
  };

  const loadAll = async (did?: string): Promise<ActiveMemberRecord[]> => {
    const perRole = await Promise.all(rolePaths.map(role => loadRole(role, did)));
    return perRole.flat();
  };

  const rolePrecedence = new Map(rolePaths.map((role, index) => [role, index]));
  const prefer = (
    current: ActiveMemberRecord | undefined,
    candidate: ActiveMemberRecord,
  ): ActiveMemberRecord => {
    if (current === undefined) {
      return candidate;
    }
    const precedence = (rolePrecedence.get(candidate.role) ?? -1) - (rolePrecedence.get(current.role) ?? -1);
    if (precedence !== 0) {
      return precedence < 0 ? candidate : current;
    }
    return compareRecordsNewestFirst(candidate.record, current.record) < 0 ? candidate : current;
  };

  const preferred = (candidates: readonly ActiveMemberRecord[]): ActiveMemberRecord | undefined =>
    candidates.reduce<ActiveMemberRecord | undefined>((acc, item) => prefer(acc, item), undefined);

  const resolveDelivery = async (
    roleRecordId: string,
    retry = false,
    outcome?: AudienceKeyDeliveryOutcome,
  ): Promise<RoleDeliveryState> => {
    if (outcome !== undefined) {
      return outcome;
    }
    const deliveryApi = rootTyped.roleDelivery;
    if (deliveryApi === undefined) {
      return Object.freeze({ state: 'delivered' as const });
    }
    const resolved = retry
      ? await deliveryApi.retry(roleRecordId)
      : await deliveryApi.get(roleRecordId);
    return resolved ?? Object.freeze({ state: 'delivered' as const });
  };

  const projectMember = async (
    member: ActiveMemberRecord,
    retry = false,
    outcome?: AudienceKeyDeliveryOutcome,
  ): Promise<ContextMember<D, C>> => {
    const [data, delivery] = await Promise.all([
      member.record.value(),
      resolveDelivery(member.record.id, retry, outcome),
    ]);
    return Object.freeze({
      data,
      delivery,
      did: member.did,
      role: member.role,
    }) as ContextMember<D, C>;
  };

  const projectList = async (members: readonly ActiveMemberRecord[]): Promise<ContextMember<D, C>[]> => {
    const byDid = new Map<string, ActiveMemberRecord>();
    for (const member of members) {
      byDid.set(member.did, prefer(byDid.get(member.did), member));
    }
    return Promise.all(
      [...byDid.entries()]
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([, member]) => projectMember(member)),
    );
  };

  const deleteAssignments = async (
    assignments: readonly ActiveMemberRecord[],
  ): Promise<PromiseRejectedResult | undefined> => {
    const results = await Promise.allSettled(assignments.map(member => member.record.delete()));
    return results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  };

  const preferredAfterFailure = async (did: string): Promise<ActiveMemberRecord | undefined> => {
    try {
      return preferred(await loadAll(did));
    } catch (cause: unknown) {
      throw new ContextNotReadyError(cause);
    }
  };

  return Object.freeze({
    get: async (did: string): Promise<ContextMember<D, C> | undefined> => {
      const member = preferred(await loadAll(normalizeMemberDid(did)));
      return member === undefined ? undefined : projectMember(member);
    },
    list: async (): Promise<ContextMember<D, C>[]> => projectList(await loadAll()),
    observe: async (options?: Readonly<{ signal?: AbortSignal }>): Promise<RecordView<ContextMember<D, C>>> => {
      const [primaryRole, ...additionalRoles] = rolePaths as [RolePath, ...RolePath[]];
      return createMappedRecordView({
        callerSignal: options?.signal,
        sessionSignal: enbox.signal,
        openInner: (signal) =>
          rootTyped.records.observe(primaryRole, {
            within: contextId,
            pagination: { limit: MEMBER_ROLE_PAGE_LIMIT },
            signal,
          }),
        openExtraWakes: async (wake, fail, signal) => {
          const detachDelivery = rootTyped.roleDelivery?.subscribe(wake) ?? ((): void => {});
          if (additionalRoles.length === 0) {
            return { close: async (): Promise<void> => detachDelivery() };
          }
          try {
            const sub = await rootTyped.records.subscribe(additionalRoles, { signal }, (event) => {
              if (event.type === 'error') {
                fail(event.error);
              } else {
                wake();
              }
            });
            return {
              close: async (): Promise<void> => {
                detachDelivery();
                await sub.close();
              },
            };
          } catch (error: unknown) {
            detachDelivery();
            throw error;
          }
        },
        project: async (primaryRecords) => {
          const primaryActive: ActiveMemberRecord[] = primaryRecords
            .filter(record => typeof record.recipient === 'string' && record.recipient.length > 0)
            .map(record => ({ did: record.recipient!, record, role: primaryRole }));
          const extra = await Promise.all(additionalRoles.map(role => loadRole(role)));
          return projectList([...primaryActive, ...extra.flat()]);
        },
      });
    },
    remove: async (did: string): Promise<void> => {
      const recipient = normalizeMemberDid(did);
      const failure = await deleteAssignments(await loadAll(recipient));
      if (failure !== undefined && (await preferredAfterFailure(recipient)) !== undefined) {
        throw new ContextNotReadyError(failure.reason);
      }
    },
    retryDelivery: async (did: string): Promise<ContextMember<D, C> | undefined> => {
      const member = preferred(await loadAll(normalizeMemberDid(did)));
      return member === undefined ? undefined : projectMember(member, true);
    },
    set: async (did: string, request: { data: unknown; role: string }): Promise<ContextMember<D, C>> => {
      const recipient = normalizeMemberDid(did);
      const role = normalizePath(request.role) as RolePath;
      if (!rolePaths.includes(role)) {
        throw new TypeError(`OwnedContext.members.set: role '${role}' is not a membership role for this context.`);
      }
      const existing = await loadAll(recipient);
      const current = preferred(existing.filter(member => member.role === role));
      let accepted: ActiveMemberRecord;
      let outcome: AudienceKeyDeliveryOutcome | undefined;
      if (current === undefined) {
        const created = await rootTyped.records.create(role, {
          data: request.data as never,
          parentContextId: contextId,
          recipient,
        });
        accepted = { did: recipient, record: created, role };
        outcome = created.audienceKeyDelivery;
      } else {
        accepted = {
          did: recipient,
          record: await current.record.update({ data: request.data }),
          role,
        };
      }
      const failure = await deleteAssignments(existing.filter(member => member.record.id !== accepted.record.id));
      if (failure !== undefined) {
        const effective = await preferredAfterFailure(recipient);
        if (effective?.role !== role) {
          throw new ContextNotReadyError(failure.reason);
        }
        if (effective.record.id !== accepted.record.id) {
          outcome = undefined;
        }
        accepted = effective;
      }
      return projectMember(accepted, false, outcome);
    },
  }) as unknown as ContextMembersApi<D, C, ModulePaths<D> & string>;
}

async function createMappedRecordView<Raw, Projected>(options: {
  callerSignal?: AbortSignal;
  sessionSignal?: AbortSignal;
  openInner(signal: AbortSignal): Promise<ExpandableRecordView<Raw>>;
  openExtraWakes?(
    wake: () => void,
    fail: (error: Error) => void,
    signal: AbortSignal,
  ): Promise<{ close(): Promise<void> }>;
  project(records: readonly Raw[]): Promise<readonly Projected[]>;
}): Promise<RecordView<Projected>> {
  options.callerSignal?.throwIfAborted();
  options.sessionSignal?.throwIfAborted();
  const view = new MappedRecordView(options);
  await openView(view, [options.callerSignal, options.sessionSignal]);
  return view;
}

class MappedRecordView<Raw, Projected> extends ObservedView<RecordViewState<Projected>> implements RecordView<Projected> {
  private _inner?: ExpandableRecordView<Raw>;
  private _extraWakes?: { close(): Promise<void> };
  private _unsubscribeInner?: () => void;

  public constructor(
    private readonly _options: {
      callerSignal?: AbortSignal;
      sessionSignal?: AbortSignal;
      openInner(signal: AbortSignal): Promise<ExpandableRecordView<Raw>>;
      openExtraWakes?(
        wake: () => void,
        fail: (error: Error) => void,
        signal: AbortSignal,
      ): Promise<{ close(): Promise<void> }>;
      project(records: readonly Raw[]): Promise<readonly Projected[]>;
    },
  ) {
    super(
      Object.freeze({ status: 'loading', current: false, hasMore: false, records: Object.freeze([]) }),
      _options.callerSignal,
      _options.sessionSignal,
    );
  }

  public async open(): Promise<void> {
    const signal = this._closeController.signal;
    const inner = await whileSignalsActive(
      () => this._options.openInner(signal),
      [signal, this._callerSignal, this._sessionSignal],
    );
    if (this.isClosed) {
      await inner.close();
      return;
    }
    this._inner = inner;
    if (this._options.openExtraWakes !== undefined) {
      this._extraWakes = await this._options.openExtraWakes(
        () => this.requestMaterialization(),
        (error) => {
          if (!this.isClosed) {
            this.publishError(error);
            void this.close().catch((): void => {});
          }
        },
        signal,
      );
    }
    this._unsubscribeInner = inner.subscribe(() => {
      this.requestMaterialization();
    });
    this.requestMaterialization();
  }

  public async refresh(): Promise<Extract<RecordViewState<Projected>, { status: 'ready' }>> {
    if (this.isClosed || this._inner === undefined) {
      return this.ready();
    }
    await this._inner.refresh();
    this.requestMaterialization();
    await this.waitForActiveMaterialization();
    return this.ready();
  }

  protected async materialize(generation: number): Promise<void> {
    const inner = this._inner;
    if (inner === undefined || this.isClosed) {
      return;
    }
    const rawState = inner.getSnapshot();
    if (rawState.status === 'loading') {
      return;
    }
    if (rawState.status === 'error') {
      if (this.canPublishMaterialization(generation)) {
        this.publishError(rawState.error);
      }
      return;
    }
    try {
      const projected = await this._options.project(rawState.records);
      if (this.canPublishMaterialization(generation)) {
        this.publish(Object.freeze({
          status: 'ready',
          current: rawState.current,
          hasMore: rawState.hasMore,
          records: Object.freeze([...projected]),
        }));
      }
    } catch (error: unknown) {
      if (this.canPublishMaterialization(generation)) {
        this.publishError(error);
      }
    }
  }

  protected handleLifetimeAbort(reason: unknown, sessionEnded: boolean): void {
    if (sessionEnded) {
      this.publishError(reason);
    }
  }

  protected async closeOwnedResources(): Promise<void> {
    this._unsubscribeInner?.();
    this._unsubscribeInner = undefined;
    const results = await Promise.allSettled([this._extraWakes?.close(), this._inner?.close()]);
    this._extraWakes = undefined;
    this._inner = undefined;
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed !== undefined) {
      throw failed.reason;
    }
  }

  private publishError(cause: unknown): void {
    this.publish(toRecordViewErrorState(this.getSnapshot(), cause));
  }
}

function filterReplicatedRolePaths(
  scope: ResolvedModuleRoleScope,
  replicatedModulePaths: readonly string[],
): Set<string> {
  const replicated = new Set(replicatedModulePaths);
  const readable = new Set(scope.readablePaths);
  return new Set(
    [...scope.allowedPaths].filter(path => !readable.has(path) || replicated.has(path)),
  );
}

async function verifyMemberConsumerCapture(options: {
  accepted: FollowedModuleScope;
  attachmentPath: string;
  consumerGraph: ResolvedModuleGraph;
  consumerModuleUri: string;
  initialScope: ResolvedModuleRoleScope | undefined;
  rootRoleRef: ResolvedRoleReference;
  sync: SyncEngineHost;
  verifiedSource: FollowedSyncSource;
}): Promise<ReadonlySet<string>> {
  const {
    accepted,
    attachmentPath,
    consumerGraph,
    consumerModuleUri,
    initialScope,
    rootRoleRef,
    sync,
    verifiedSource,
  } = options;
  // Attachment mismatch is a terminal contract mismatch, not transient readiness.
  if (accepted.contextPath !== attachmentPath) {
    throw new Error('Context.using: verified consumer attachment path differs from the typed context binding.');
  }
  let actualGraph: ResolvedModuleGraph;
  try {
    actualGraph = await sync.resolveFollowedSourceModuleGraph(verifiedSource, consumerModuleUri);
  } catch (error: unknown) {
    if (isFollowedSourceNotReadyError(error)) {
      throw new ContextNotReadyError(error);
    }
    throw error;
  }
  if (actualGraph.rootModuleUri !== consumerModuleUri) {
    throw new Error('Context.using: verified context graph belongs to a different module.');
  }
  const actualRole = actualGraph.resolveInvokedRole(accepted.moduleRole);
  if (
    actualRole.owningModuleUri !== rootRoleRef.owningModuleUri
    || actualRole.owningModulePath !== rootRoleRef.owningModulePath
  ) {
    throw new Error('Context.using: verified consumer role no longer identifies the accepted root membership.');
  }
  if (initialScope === undefined) {
    throw new ContextNotReadyError(
      new Error(`Role '${accepted.moduleRole}' has no readable paths in '${consumerModuleUri}'.`),
    );
  }
  const actualScope = resolveModuleRoleScope(actualGraph, rootRoleRef);
  const actualPermitted = filterReplicatedRolePaths(actualScope, accepted.modulePaths);
  const permitted = [...initialScope.allowedPaths].filter(path => actualPermitted.has(path));
  for (const path of permitted) {
    const actualNode = actualGraph.nodesByDeclaredPath.get(path);
    const expectedNode = consumerGraph.nodesByDeclaredPath.get(path);
    if (
      actualNode?.kind !== 'record'
      || expectedNode?.kind !== 'record'
      || !recordRepresentationsEqual(expectedNode, actualNode)
    ) {
      throw new Error(
        `Context.using: owner module '${consumerModuleUri}' changed the consumed representation at '${path}'.`,
      );
    }
  }
  return new Set(permitted);
}

function createProjectedConsumerObserve(options: {
  bindingSignal: AbortSignal;
  consumerModuleUri: string;
  contextId: string;
  contextSignal: AbortSignal;
  enboxSignal: AbortSignal;
  getGeneration: (
    path: string,
    request: ContextObserveRequest<ModuleDefinition, string>,
  ) => () => ProjectionViewGeneration<unknown>;
  rootLease: FollowedModuleLease;
  source: FollowedSyncSource;
  staticConsumerPaths: ReadonlySet<string>;
  sync: SyncEngineHost;
}): ContextModuleBinding['records']['observe'] {
  const {
    bindingSignal,
    consumerModuleUri,
    contextId,
    contextSignal,
    enboxSignal,
    getGeneration,
    rootLease,
    source,
    staticConsumerPaths,
    sync,
  } = options;
  return (async (
    rawPath: string,
    request: ContextObserveRequest<ModuleDefinition, string>,
  ): Promise<ExpandableRecordView<unknown>> => {
    enboxSignal.throwIfAborted();
    bindingSignal.throwIfAborted();
    request?.signal?.throwIfAborted();
    const path = normalizePath(rawPath);
    if (!staticConsumerPaths.has(path)) {
      throw new TypeError(`Context-bound records do not expose path '${path}'.`);
    }
    const limit = request?.pagination?.limit;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError('records.observe: pagination.limit must be a positive safe integer.');
    }
    if (request.within !== undefined && (!isValidContextId(request.within) || !matchesSubtree(contextId, request.within))) {
      throw new TypeError('Context-bound selectors cannot escape their context.');
    }
    return createProjectedRecordView({
      callerSignal: request.signal,
      module: consumerModuleUri,
      signal: contextSignal,
      source,
      root: rootLease,
      sync,
      generation: getGeneration(path, request),
    });
  }) as ContextModuleBinding['records']['observe'];
}

function collectSubtreeRecordPaths(
  graph: ResolvedModuleGraph,
  rootPath: string,
  includeRoot: boolean,
): Set<string> {
  const prefix = `${rootPath}/`;
  return new Set(
    [...graph.nodesByDeclaredPath.values()]
      .filter(
        node =>
          node.kind === 'record'
          && node.ruleSet.$role !== true
          && (includeRoot ? matchesSubtree(rootPath, node.declaringModulePath) : node.declaringModulePath.startsWith(prefix)),
      )
      .map(node => node.declaringModulePath),
  );
}

function getContextRoles(
  rootGraph: ResolvedModuleGraph,
  path: string,
): readonly string[] {
  const rootSegment = path.split('/')[0]!;
  const node = rootGraph.nodesByDeclaredPath.get(path);
  if (
    node?.kind !== 'record'
    || node.ruleSet.$role === true
    || rootGraph.nodesByDeclaredPath.get(rootSegment)?.kind === 'ref'
  ) {
    return [];
  }
  return resolveModuleContextRoles(rootGraph, path);
}

function resolveRecordNode(graph: ResolvedModuleGraph, path: string): ResolvedModuleNode {
  const node = graph.nodesByDeclaredPath.get(path);
  if (node?.kind !== 'record') {
    const valid = [...graph.nodesByDeclaredPath.values()]
      .filter(candidate => candidate.kind === 'record')
      .map(candidate => candidate.declaringModulePath);
    throw new TypeError(`Invalid module path '${path}'. Valid paths are: ${valid.join(', ')}.`);
  }
  return node;
}

function normalizePath(path: string): string {
  if (!isCanonicalModulePath(path)) {
    throw new TypeError(`Invalid module path '${String(path)}'.`);
  }
  return path;
}

function normalizeMemberDid(did: string): string {
  const trimmed = typeof did === 'string' ? did.trim() : '';
  if (!isValidDidUri(trimmed)) {
    throw new TypeError(`Invalid member DID '${String(did)}'.`);
  }
  return trimmed;
}

function normalizeFollowTarget(target: ContextFollowTarget, caller: string): ContextFollowTarget {
  if (target === null || typeof target !== 'object') {
    throw new TypeError(`${caller}: target must be an object with ownerDid and id.`);
  }
  const ownerDid = typeof target.ownerDid === 'string' ? target.ownerDid.trim() : '';
  if (!isValidDidUri(ownerDid)) {
    throw new TypeError(`${caller}: invalid ownerDid '${String(target.ownerDid)}'.`);
  }
  if (!isValidContextId(target.id)) {
    throw new TypeError(`${caller}: invalid context id '${String(target.id)}'.`);
  }
  return { id: target.id, ownerDid };
}

function normalizeInvitationPreview(preview: ContextInvitationPreview | undefined): ContextInvitationPreview {
  if (preview === undefined) {
    return Object.freeze({});
  }
  if (!isPlainObject(preview)) {
    throw new TypeError('OwnedContext.invite: preview must be a plain string record.');
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(preview)) {
    if (typeof value !== 'string') {
      throw new TypeError(`OwnedContext.invite: preview['${key}'] must be a string.`);
    }
    normalized[key] = value;
  }
  return Object.freeze(normalized);
}

function normalizeInvitationLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_INVITATION_LIMIT;
  }
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError('ContextInvitationsApi: limit must be a positive safe integer.');
  }
  return limit;
}

function contextRootRecordId(contextId: string): string {
  return contextId.slice(contextId.lastIndexOf('/') + 1);
}

function compareModuleContexts(
  left: { access: 'owner' | 'member'; key: string },
  right: { access: 'owner' | 'member'; key: string },
): number {
  if (left.access !== right.access) {
    return left.access === 'owner' ? -1 : 1;
  }
  return compareCodeUnits(left.key, right.key);
}
