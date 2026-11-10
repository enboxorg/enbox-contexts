import type { ContextInvitationPreview } from './companion-module.js';
import type { ContextView, MaterializedMemberContext as MaterializedMemberContextRow } from './context-view.js';
import type { ObservableStore } from './observed-view.js';

// ---------------------------------------------------------------------------
// Structural DWN Module Definition & Codec Contracts (aligned with @enbox/dwn-sdk-js & @enbox/api)
// ---------------------------------------------------------------------------

export type JwkOperation = 'encrypt' | 'decrypt' | 'sign' | 'verify' | 'deriveKey' | 'deriveBits' | 'wrapKey' | 'unwrapKey';

export type JwkUse = 'sig' | 'enc' | (string & {});

export type JwkParamsBase = {
  alg?: string;
  ext?: 'true' | 'false';
  key_ops?: JwkOperation[];
  kid?: string;
  use?: JwkUse;
  x5c?: string;
  x5t?: string;
  'x5t#S256'?: string;
  x5u?: string;
};

export type PublicKeyJwk =
  | (Omit<JwkParamsBase, 'alg'> & {
    alg?: 'ES256' | 'ES256K' | 'ES384' | 'ES512';
    kty: 'EC';
    crv: 'secp256k1' | 'P-256' | 'P-384' | 'P-521';
    x: string;
    y?: string;
  })
  | (Omit<JwkParamsBase, 'alg'> & {
    alg?: 'EdDSA';
    kty: 'OKP';
    crv: 'Ed25519' | 'Ed448' | 'X25519' | 'X448';
    x: string;
  })
  | (JwkParamsBase & {
    kty: 'RSA';
    e: string;
    n: string;
  });

export type ModuleKeyAgreement = {
  publicKeyJwk: PublicKeyJwk;
};

export type ModuleSizeDefinition = {
  min?: number;
  max?: number;
};

export type ModuleRecordLimitDefinition = {
  max: number;
};

export type ModuleDeliveryStrategy = 'direct' | 'subscribe';

export type ModuleTagSchema = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  items?: { type: 'string' | 'number' | 'integer' };
  contains?: { type: 'string' | 'number' | 'integer' };
  enum?: (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minContains?: number;
  maxContains?: number;
};

export type ModuleTagsDefinition = {
  $requiredTags?: string[];
  $allowUndefinedTags?: boolean;
  [tag: string]: ModuleTagSchema | string[] | boolean | undefined;
};

export type ModuleActionRule = {
  who?: string;
  role?: string;
  of?: string;
  can: string[];
};

type ModuleRuleSetValue =
  | ModuleRuleSet
  | ModuleActionRule[]
  | ModuleKeyAgreement
  | ModuleTagsDefinition
  | ModuleSizeDefinition
  | ModuleRecordLimitDefinition
  | boolean
  | string
  | undefined;

export type ModuleRuleSet = {
  $keyAgreement?: ModuleKeyAgreement;
  $actions?: ModuleActionRule[];
  $role?: boolean;
  $ref?: string;
  $size?: ModuleSizeDefinition;
  $tags?: ModuleTagsDefinition;
  $recordLimit?: ModuleRecordLimitDefinition;
  $immutable?: boolean;
  $delivery?: ModuleDeliveryStrategy;
  $squash?: boolean;
  [key: string]: ModuleRuleSetValue;
};

export type ModuleType = {
  schema?: string;
  dataFormats?: string[];
  encryptionRequired?: boolean;
};

export type ModuleTypes = {
  [key: string]: ModuleType;
};

export type ModuleUses = {
  [alias: string]: string;
};

export type ModuleDefinition = {
  module: string;
  $keyAgreement?: ModuleKeyAgreement;
  published: boolean;
  uses?: ModuleUses;
  types: ModuleTypes;
  structure: {
    [key: string]: ModuleRuleSet;
  };
};

export type EncodedRecordData = {
  data: Blob;
  dataFormat: string;
};

export type RecordCodecContext = Readonly<{
  modulePath?: string;
  recordId?: string;
  schema?: string;
}>;

export interface RecordCodec<T = unknown> {
  encode(value: T, context?: RecordCodecContext): EncodedRecordData | Promise<EncodedRecordData>;
  decode(data: RecordDataReader, dataFormat: string, context?: RecordCodecContext): Promise<T>;
}

export type RecordCodecMap = Record<string, RecordCodec<unknown>>;

export type RecordCodecValue<Codec> = Codec extends RecordCodec<infer T> ? T : never;

export type ModuleDependency = {
  readonly definition: ModuleDefinition;
  readonly codecs: RecordCodecMap;
  readonly dependencies: ModuleDependencies;
};

export type ModuleDependencies = Readonly<Record<string, ModuleDependency>>;

export type TypedModule<
  D extends ModuleDefinition = ModuleDefinition,
  C extends RecordCodecMap = RecordCodecMap,
  Deps extends ModuleDependencies = ModuleDependencies,
> = {
  readonly definition: D;
  readonly codecs: C;
  readonly dependencies: Deps;
};

// ---------------------------------------------------------------------------
// Compile-Time Module Path, Role, and Attachment Inference
// ---------------------------------------------------------------------------

export type RuleSetPaths<R, Prefix extends string = ''> = string extends keyof R ? string : {
  [K in Extract<keyof R, string>]: K extends `$${string}`
    ? never
    : R[K] extends ModuleRuleSet
      ? (R[K] extends { readonly $ref: string } ? never : `${Prefix}${K}`) | RuleSetPaths<R[K], `${Prefix}${K}/`>
      : never;
}[Extract<keyof R, string>];

export type ModulePaths<D extends ModuleDefinition> = RuleSetPaths<D['structure']>;

export type TypeNameAtPath<Path extends string> =
  Path extends `${string}/${infer Rest}`
    ? TypeNameAtPath<Rest>
    : Path;

export type DataForPath<C extends RecordCodecMap, Path extends string> =
  TypeNameAtPath<Path> extends keyof C
    ? RecordCodecValue<C[TypeNameAtPath<Path>]>
    : unknown;

type RuleSetAtPath<R, Path extends string> =
  Path extends `${infer Head}/${infer Tail}`
    ? Head extends keyof R
      ? R[Head] extends ModuleRuleSet
        ? RuleSetAtPath<R[Head], Tail>
        : never
      : never
    : Path extends keyof R
      ? R[Path] extends ModuleRuleSet
        ? R[Path]
        : never
      : never;

type DeclaredPaths<R, Prefix extends string = ''> = string extends keyof R ? string : {
  [K in Extract<keyof R, string>]: K extends `$${string}` ? never
    : R[K] extends ModuleRuleSet ? `${Prefix}${K}` | DeclaredPaths<R[K], `${Prefix}${K}/`> : never;
}[Extract<keyof R, string>];

type AttachmentTarget = { module: string; path: string };

type ResolveAttachmentTarget<
  M extends ModuleDependency,
  Path extends string,
  Seen extends string = never,
> = string extends keyof M['definition']['structure'] ? AttachmentTarget
  : string extends Path ? AttachmentTarget
    : M['definition']['module'] extends Seen ? never
      : RuleSetAtPath<M['definition']['structure'], Path> extends infer Node
        ? [Node] extends [never] ? never
          : Node extends { readonly $ref: infer Reference extends string }
            ? string extends Reference ? AttachmentTarget
              : Reference extends `${infer Alias}:${infer Target}`
                ? Alias extends keyof M['dependencies']
                  ? ResolveAttachmentTarget<
                    M['dependencies'][Alias],
                    Target,
                    Seen | (string extends M['definition']['module'] ? never : M['definition']['module'])
                  >
                  : never
                : never
            : { module: M['definition']['module']; path: Path }
        : never;

type MatchesAttachmentTarget<Target, ModuleUri extends string, ModulePath extends string> =
  Target extends AttachmentTarget
    ? [Target['module'] & ModuleUri] extends [never] ? false
      : [Target['path'] & ModulePath] extends [never] ? false : true
    : false;

export type ModuleAttachmentPaths<
  M extends TypedModule,
  OwningModuleUri extends string,
  OwningModulePath extends string,
> = string extends keyof M['definition']['structure'] ? string : {
  [Path in DeclaredPaths<M['definition']['structure']>]:
    RuleSetAtPath<M['definition']['structure'], Path> extends { readonly $ref: string }
      ? true extends MatchesAttachmentTarget<ResolveAttachmentTarget<M, Path>, OwningModuleUri, OwningModulePath>
        ? Path
        : never
      : never;
}[DeclaredPaths<M['definition']['structure']>];

type ResolvedRoleAtPath<
  D extends ModuleDefinition,
  Deps extends ModuleDependencies,
  Path extends string,
  Seen extends string = never,
> = D['module'] extends Seen ? false
  : RuleSetAtPath<D['structure'], Path> extends infer Node
    ? Node extends { readonly $role: true } ? true
      : Node extends { readonly $ref: `${infer Alias}:${infer Target}` }
        ? Alias extends keyof Deps
          ? ResolvedRoleAtPath<
            Deps[Alias]['definition'],
            Deps[Alias]['dependencies'],
            Target,
            Seen | (string extends D['module'] ? never : D['module'])
          >
          : false
        : false
    : false;

type DeclaredRolePaths<D extends ModuleDefinition, Deps extends ModuleDependencies> =
  string extends keyof D['structure'] ? never : {
    [Path in DeclaredPaths<D['structure']>]: ResolvedRoleAtPath<D, Deps, Path> extends true ? Path : never;
  }[DeclaredPaths<D['structure']>];

export type ModuleRolePaths<
  D extends ModuleDefinition,
  Deps extends ModuleDependencies = ModuleDependencies,
> = DeclaredRolePaths<D, Deps> | {
  [Alias in Extract<keyof Deps, string>]: `${Alias}:${DeclaredRolePaths<Deps[Alias]['definition'], Deps[Alias]['dependencies']>}`;
}[Extract<keyof Deps, string>];

export type SquashModulePaths<D extends ModuleDefinition> = {
  [Path in ModulePaths<D>]: RuleSetAtPath<D['structure'], Path> extends {
    readonly $squash: true;
  }
    ? Path
    : never;
}[ModulePaths<D>];

export type SingletonModulePaths<D extends ModuleDefinition> = {
  [Path in ModulePaths<D>]: RuleSetAtPath<D['structure'], Path> extends {
    readonly $recordLimit: { readonly max: 1 };
  }
    ? Path
    : never;
}[ModulePaths<D>];

export type DirectSingletonChildPaths<
  D extends ModuleDefinition,
  Parent extends ModulePaths<D>,
> = RuleSetAtPath<D['structure'], Parent> extends infer ParentRuleSet
  ? ParentRuleSet extends ModuleRuleSet
    ? {
      [Child in Extract<keyof ParentRuleSet, string>]: Child extends `$${string}`
        ? never
        : ParentRuleSet[Child] extends {
          readonly $recordLimit: { readonly max: 1 };
        }
          ? `${Parent}/${Child}`
          : never;
    }[Extract<keyof ParentRuleSet, string>]
    : never
  : never;

type ReadActionRole<Action> = Action extends {
  readonly role: infer Role extends string;
  readonly can: readonly string[];
} ? Extract<Action['can'][number], 'read'> extends never ? never : Role : never;

type DirectRolePaths<RuleSet, Root extends string> = {
  [Child in Extract<keyof RuleSet, string>]: Child extends `$${string}`
    ? never
    : RuleSet[Child] extends { readonly $role: true } ? `${Root}/${Child}` : never;
}[Extract<keyof RuleSet, string>];

type IsLocallyRooted<D extends ModuleDefinition, Path extends string> =
  Path extends `${infer Head}/${string}`
    ? D['structure'][Head] extends { readonly $ref: string } ? false : true
    : D['structure'][Path] extends { readonly $ref: string } ? false : true;

/** Contextual roles directly below a root whose actions grant them read access (both encrypted and plaintext roots). */
export type ContextRolesAtPath<
  D extends ModuleDefinition,
  Root extends ModulePaths<D> & string,
> = Root extends unknown
  ? IsLocallyRooted<D, Root> extends false ? never
    : RuleSetAtPath<D['structure'], Root> extends infer RuleSet
      ? RuleSet extends { readonly $role: true } ? never
        : RuleSet extends { readonly $actions: readonly (infer Action)[] }
          ? Extract<ReadActionRole<Action>, DirectRolePaths<RuleSet, Root>>
          : never
      : never
  : never;

/** Context roots with at least one direct role granted read access. */
export type ContextRootPath<D extends ModuleDefinition> = {
  [Path in ModulePaths<D> & string]: [ContextRolesAtPath<D, Path>] extends [never] ? never : Path;
}[ModulePaths<D> & string];

/** Every role eligible for following through its directly containing context. */
export type ContextRolePath<D extends ModuleDefinition> = {
  [Path in ModulePaths<D> & string]: ContextRolesAtPath<D, Path>;
}[ModulePaths<D> & string];

// ---------------------------------------------------------------------------
// Structural Resolved Graph & Sync Contracts
// ---------------------------------------------------------------------------

export type ResolvedRoleReference = Readonly<{
  owningModuleUri: string;
  owningModulePath: string;
}>;

export type ModuleContextRoot = Readonly<{
  owningModuleUri: string;
  owningModulePath: string;
}>;

export type ResolvedModuleNode = ModuleContextRoot & Readonly<{
  kind: 'record' | 'ref';
  declaringModuleUri: string;
  declaringModulePath: string;
  physicalAncestors: readonly Readonly<{
    owningModuleUri: string;
    owningModulePath: string;
  }>[];
  physicalDepth: number;
  typeName: string;
  recordType: ModuleType;
  ruleSet: ModuleRuleSet;
}>;

export type ResolvedModuleGraph = Readonly<{
  rootModuleUri: string;
  nodesByDeclaredPath: ReadonlyMap<string, ResolvedModuleNode>;
  resolveInvokedRole(rolePath: string): ResolvedRoleReference;
}>;

export type ResolvedModuleRoleScope = Readonly<{
  contextPath: string;
  readablePaths: readonly string[];
  allowedPaths: ReadonlySet<string>;
}>;

export type FollowedModuleScope = Readonly<{
  contextPath: string;
  moduleRole: string;
  modulePaths: readonly string[];
}>;

export type FollowedSyncSource = Readonly<{
  id: string;
  acceptanceId: string;
  actorDid: string;
  sourceDid: string;
  rootModule: string;
  contextId: string;
  roles: readonly string[];
  remoteEndpoint: string;
  modules: Readonly<Record<string, FollowedModuleScope | null>>;
}>;

export type SyncEventScope = {
  contextId?: string;
  module?: string;
  modules?: readonly [string, ...string[]] | readonly string[];
};

type SyncEventBase = {
  tenantDid: string;
  remoteEndpoint?: string;
} & SyncEventScope;

export type SyncMessageDescriptor = {
  interface: string;
  method: string;
  messageTimestamp?: string;
  module?: string;
  modulePath?: string;
  recordId?: string;
  contextId?: string;
  author?: string;
};

export type SyncEvent =
  | { type: 'identity:registration-change'; tenantDid: string; options?: unknown }
  | { type: 'dead-letter:change'; tenantDid: string; remoteEndpoint: string }
  | {
    type: 'followed-context:change';
    actorDid: string;
    contextId: string;
    followedSourceAcceptanceId: string;
    followedSourceId: string | undefined;
    affectedModules?: readonly string[];
    module: string;
    tenantDid: string;
  }
  | (SyncEventBase & { type: 'link:status-change'; from: string; to: string })
  | (SyncEventBase & { type: 'link:connectivity-change'; from: 'online' | 'offline' | 'unknown'; to: 'online' | 'offline' | 'unknown' })
  | (SyncEventBase & { type: 'pull:currentness-change'; from: boolean; to: boolean })
  | (SyncEventBase & { type: 'checkpoint:pull-advance'; position: string; messageCid?: string })
  | (SyncEventBase & { type: 'checkpoint:push-advance'; position: string; messageCid?: string })
  | (SyncEventBase & { type: 'delivery:applied'; messageCid: string; descriptor: SyncMessageDescriptor })
  | (SyncEventBase & { type: 'reconcile:needed'; reason: string })
  | (SyncEventBase & { type: 'reconcile:completed' })
  | (SyncEventBase & { type: 'repair:started'; attempt: number })
  | (SyncEventBase & { type: 'repair:completed' })
  | (SyncEventBase & { type: 'repair:failed'; attempt: number; error: string })
  | (SyncEventBase & { type: 'push:quota-blocked'; messageCid: string; detail?: string; nextProbeAt: string })
  | (SyncEventBase & { type: 'push:quota-cleared'; messageCid: string; resolution: string });

export interface SyncEngineHost {
  followSource(options: {
    actorDid: string;
    sourceDid: string;
    rootModule: string;
    contextPath: string;
    contextId: string;
    roles: string[];
    modules?: readonly string[];
  }): Promise<FollowedSyncSource>;
  ensureFollowedSourceModules(source: FollowedSyncSource, modules: readonly string[]): Promise<FollowedSyncSource>;
  resolveFollowedSourceModuleGraph(source: FollowedSyncSource, module: string): Promise<ResolvedModuleGraph>;
  getFollowedSource(id: string): Promise<FollowedSyncSource | undefined>;
  listFollowedSources(): Promise<FollowedSyncSource[]>;
  deleteFollowedSource(source: FollowedSyncSource): Promise<unknown>;
  pullFollowedSource(source: FollowedSyncSource, module?: string): Promise<boolean>;
  markFollowedSourcePullPending(source: FollowedSyncSource, module?: string): Promise<unknown>;
  on(listener: (event: SyncEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// Record & View Contracts (aligned with @enbox/api)
// ---------------------------------------------------------------------------

export type RecordExecutionContext = {
  readonly tenantDid: string;
  readonly contextId?: string;
  readonly followedSourceId?: string;
  readonly moduleRole?: string;
  readonly remoteEndpoint?: string;
  assertActive?(): Promise<void>;
  invalidateReplica?(): Promise<void>;
};

export type RoleDeliveryState =
  | Readonly<{ state: 'delivered' }>
  | Readonly<{ state: 'pending'; reason?: string }>
  | Readonly<{ state: 'awaiting-recipient-install' | 'failed'; reason: string }>;

export type AudienceKeyDeliveryOutcome = RoleDeliveryState;

export type RecordDataReader = {
  blob: () => Promise<Blob>;
  bytes: () => Promise<Uint8Array>;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  stream: () => Promise<ReadableStream>;
  then: (
    onFulfilled?: (value: ReadableStream) => ReadableStream | PromiseLike<ReadableStream>,
    onRejected?: (reason: unknown) => PromiseLike<never>,
  ) => Promise<ReadableStream>;
  catch: (onRejected?: (reason: unknown) => PromiseLike<never>) => Promise<ReadableStream>;
};

export type ContextRecordUpdateParams<T = unknown> = {
  data?: T;
  datePublished?: string;
  published?: boolean;
  tags?: Record<string, string | number | boolean | string[] | number[]>;
  timestamp?: string;
};

export type ContextRecordDeleteParams = {
  prune?: boolean;
  timestamp?: string;
};

export type ContextRecord<T = unknown> = {
  readonly author: string;
  readonly creator: string;
  readonly data: RecordDataReader;
  readonly dataCid?: string;
  readonly dataFormat?: string;
  readonly dataSize?: number;
  readonly dateCreated: string;
  readonly datePublished?: string;
  readonly deleted: boolean;
  readonly id: string;
  readonly parentId?: string;
  readonly published?: boolean;
  readonly recipient?: string;
  readonly tags?: Record<string, string | number | boolean | string[] | number[]>;
  readonly timestamp: string;
  readonly contextId: string;
  readonly module: string;
  readonly modulePath: string;
  readonly squash: boolean;
  readonly audienceKeyDelivery?: AudienceKeyDeliveryOutcome;
  value(): Promise<T>;
  delete(params?: ContextRecordDeleteParams): Promise<void>;
  update(params: ContextRecordUpdateParams<T>): Promise<ContextRecord<T>>;
};

export type ContextMaterializedRecord<T = unknown> = Readonly<{
  record: ContextRecord<T>;
  value: T;
}>;

export type RecordPage<Item = ContextRecord> = AsyncIterable<Item> & {
  records: Item[];
  next(): Promise<RecordPage<Item> | undefined>;
};

export type RecordViewState<Item> = Readonly<{
  records: readonly Item[];
  hasMore: boolean;
  current: boolean;
}> & Readonly<
  | { status: 'loading'; error?: never }
  | { status: 'ready'; error?: never }
  | { status: 'error'; error: Error }
>;

export interface RecordView<Item> extends ObservableStore<RecordViewState<Item>> {
  ready(options?: Readonly<{ signal?: AbortSignal }>): Promise<Extract<RecordViewState<Item>, { status: 'ready' }>>;
  refresh(): Promise<Extract<RecordViewState<Item>, { status: 'ready' }>>;
  close(): Promise<void>;
}

export interface ExpandableRecordView<Item> extends RecordView<Item> {
  loadMore(): Promise<void>;
}

export type RecordSubscriptionEvent<Path extends string = string, Item = ContextRecord> = Readonly<
  | { path: Path; record: Item; type: 'write' | 'delete' }
  | { type: 'error'; error: Error }
>;

export type RecordSubscriptionListener<Path extends string = string, Item = ContextRecord> = (
  event: RecordSubscriptionEvent<Path, Item>,
) => void | Promise<void>;

export interface RecordSubscription {
  close(): Promise<void>;
}

type RecordPatch<T> = T extends readonly unknown[] | ((...args: never[]) => unknown)
  ? never
  : T extends Record<string, unknown>
    ? { [K in keyof T]?: T[K] | (undefined extends T[K] ? null : never) }
    : never;

export type RecordPatchInput<T> = [RecordPatch<T>] extends [never]
  ? never
  : RecordPatch<T> | ((current: T) => RecordPatch<T> | undefined | Promise<RecordPatch<T> | undefined>);

export type ContextRecordMaterialization<
  D extends ModuleDefinition,
  Path extends ModulePaths<D> & string,
> = true | {
  children: readonly Exclude<DirectSingletonChildPaths<D, Path>, ModuleRolePaths<D>>[];
};

type SelectedMaterializedChildPaths<
  D extends ModuleDefinition,
  Path extends ModulePaths<D> & string,
  Materialization extends ContextRecordMaterialization<D, Path>,
> = Materialization extends { children: readonly (infer ChildPath)[] }
  ? Extract<ChildPath, DirectSingletonChildPaths<D, Path>>
  : never;

type MaterializedChildren<
  D extends ModuleDefinition,
  C extends RecordCodecMap,
  Path extends ModulePaths<D> & string,
  Materialization extends ContextRecordMaterialization<D, Path>,
> = {
  readonly [ChildPath in SelectedMaterializedChildPaths<D, Path, Materialization>
    as TypeNameAtPath<ChildPath>]: ContextMaterializedRecord<DataForPath<C, ChildPath>> | undefined;
};

export type ContextRecordRepresentation<
  D extends ModuleDefinition,
  C extends RecordCodecMap,
  Path extends ModulePaths<D> & string,
  Materialization extends ContextRecordMaterialization<D, Path> | undefined = undefined,
> = Materialization extends undefined
  ? ContextRecord<DataForPath<C, Path>>
  : Materialization extends true
    ? ContextMaterializedRecord<DataForPath<C, Path>>
    : ContextMaterializedRecord<DataForPath<C, Path>> & Readonly<{
      children: Readonly<MaterializedChildren<D, C, Path, Exclude<Materialization, undefined>>>;
    }>;

type ContextRecordPaths<
  D extends ModuleDefinition,
  Root extends string,
> = Exclude<
  Extract<ModulePaths<D> & string, Root | `${Root}/${string}`>,
  ModuleRolePaths<D>
>;

/** Fix #9: preserve concrete module paths when `Root` is widened to `string`. */
type ContextDescendantPaths<
  D extends ModuleDefinition,
  Root extends string,
> = string extends Root
  ? Exclude<ModulePaths<D> & string, ModuleRolePaths<D>>
  : Root extends string
    ? Exclude<ContextRecordPaths<D, Root>, Root>
    : never;

export type ContextCreateRequest<
  D extends ModuleDefinition,
  C extends RecordCodecMap,
  Path extends ModulePaths<D> & string,
> = {
  data: DataForPath<C, Path>;
  parentContextId?: string;
  published?: boolean;
  datePublished?: string;
  dateCreated?: string;
  messageTimestamp?: string;
  recipient?: string;
  tags?: Record<string, string | number | boolean | string[] | number[]>;
} & (
  ModuleDefinition extends D
    ? unknown
    : [Path] extends [SquashModulePaths<D>]
      ? { squash?: true }
      : { squash?: never }
);

export type ContextRecordQuery = {
  filter?: {
    author?: string | readonly string[];
    recipient?: string | readonly string[];
    recordId?: string;
    dataFormat?: string;
    tags?: Record<string, unknown>;
  };
  within?: string;
  dateSort?: 'createdAscending' | 'createdDescending' | 'publishedAscending' | 'publishedDescending' | 'updatedAscending' | 'updatedDescending' | (string & {});
  pagination?: { limit?: number; cursor?: { messageCid: string; value: string | number } };
};

type ContextQueryRequest<
  D extends ModuleDefinition,
  Path extends ModulePaths<D> & string,
  Materialization extends ContextRecordMaterialization<D, Path> | undefined,
> = [Materialization] extends [undefined]
  ? ContextRecordQuery & { materialize?: undefined }
  : Omit<ContextRecordQuery, 'pagination'> & {
    materialize: Materialization;
    pagination: { limit: number };
  };

type ContextQueryArguments<
  D extends ModuleDefinition,
  Path extends ModulePaths<D> & string,
  Materialization extends ContextRecordMaterialization<D, Path> | undefined,
> = [Materialization] extends [undefined]
  ? [path: Path, request?: ContextQueryRequest<D, NoInfer<Path>, Materialization>]
  : [path: Path, request: ContextQueryRequest<D, NoInfer<Path>, Materialization>];

export type ContextObserveRequest<
  D extends ModuleDefinition,
  Path extends ModulePaths<D> & string,
  Materialization extends ContextRecordMaterialization<D, Path> | undefined = undefined,
> = Omit<ContextRecordQuery, 'pagination'> & {
  pagination: { limit: number };
  signal?: AbortSignal;
} & ([Materialization] extends [undefined] ? { materialize?: undefined } : { materialize: Materialization });

export type ContextReadRequest = {
  filter: NonNullable<ContextRecordQuery['filter']>;
  within?: string;
};

export type ContextSetRequest<C extends RecordCodecMap, Path extends string> = {
  data: DataForPath<C, Path>;
  datePublished?: string;
  messageTimestamp?: string;
  published?: boolean;
  tags?: Record<string, string | number | boolean | string[] | number[]>;
  within?: string;
};

export type ContextDeleteRequest = {
  within?: string;
  recordId: string;
  prune?: boolean;
};

type SelectedSubscriptionPaths<Selection, Path extends string = string> = Selection extends Path
  ? Selection
  : Selection extends readonly (infer Selected extends Path)[] ? Selected : never;

type ContextSubscribeEvent<C extends RecordCodecMap, Paths extends string> = {
  [Path in Paths]: RecordSubscriptionEvent<Path, ContextRecord<DataForPath<C, Path>>>;
}[Paths];

type ContextSubscribeArguments<C extends RecordCodecMap, Paths extends string> =
  | [listener: (event: ContextSubscribeEvent<C, Paths>) => void | Promise<void>]
  | [options: Readonly<{ signal?: AbortSignal }>, listener: (event: ContextSubscribeEvent<C, Paths>) => void | Promise<void>]
  | [options: Readonly<{ initial: true; signal?: AbortSignal }>, listener: (event: ContextSubscribeEvent<C, Paths>) => void | Promise<void>];

export type ContextRecordsApi<
  D extends ModuleDefinition = ModuleDefinition,
  C extends RecordCodecMap = RecordCodecMap,
  Root extends string = ModulePaths<D> & string,
> = Readonly<{
  create: <Path extends ContextDescendantPaths<D, Root>>(
    path: Path,
    request: ContextCreateRequest<D, C, Path>,
  ) => Promise<ContextRecord<DataForPath<C, Path>>>;

  query: <
    Path extends ContextRecordPaths<D, Root>,
    const Materialization extends ContextRecordMaterialization<D, NoInfer<Path>> | undefined = undefined,
  >(
    ...args: ContextQueryArguments<D, Path, Materialization>
  ) => Promise<RecordPage<ContextRecordRepresentation<D, C, Path, Materialization>>>;

  observe: <
    Path extends ContextRecordPaths<D, Root>,
    const Materialization extends ContextRecordMaterialization<D, NoInfer<Path>> | undefined = undefined,
  >(
    path: Path,
    request: ContextObserveRequest<D, NoInfer<Path>, Materialization>,
  ) => Promise<ExpandableRecordView<ContextRecordRepresentation<D, C, Path, Materialization>>>;

  subscribe: <const Selection extends ContextRecordPaths<D, Root> | readonly ContextRecordPaths<D, Root>[]>(
    selection: Selection,
    ...args: ContextSubscribeArguments<C, SelectedSubscriptionPaths<Selection, ContextRecordPaths<D, Root>>>
  ) => Promise<RecordSubscription>;

  count: <Path extends ContextRecordPaths<D, Root>>(
    path: Path,
    request?: ContextRecordQuery,
  ) => Promise<number>;

  read: <Path extends ContextRecordPaths<D, Root>>(
    path: Path,
    recordIdOrRequest: string | ContextReadRequest,
  ) => Promise<ContextRecord<DataForPath<C, Path>> | undefined>;

  patch: <Path extends ContextRecordPaths<D, Root>>(
    path: Path,
    recordId: string,
    patch: RecordPatchInput<DataForPath<C, Path>>,
  ) => Promise<ContextRecord<DataForPath<C, Path>>>;

  set: <Path extends SingletonModulePaths<D> & ContextDescendantPaths<D, Root> & string>(
    path: Path,
    request: ContextSetRequest<C, Path>,
  ) => Promise<ContextRecord<DataForPath<C, Path>>>;

  delete: <Path extends ContextRecordPaths<D, Root>>(
    path: Path,
    request: ContextDeleteRequest,
  ) => Promise<void>;
}>;

// ---------------------------------------------------------------------------
// Structural Host Interfaces for `Enbox` & `TypedEnbox`
// ---------------------------------------------------------------------------

export type ScopedRecordsOptions<Root extends string = string> = Readonly<{
  contextId: string;
  contextPath: Root;
  allowedPaths: ReadonlySet<string> | (() => ReadonlySet<string>);
  execution?: RecordExecutionContext;
  prepare?: (path: string) => Promise<void>;
  signal?: AbortSignal;
}>;

export type RoleDeliveryApiHost = {
  get(roleRecordId: string): Promise<RoleDeliveryState | undefined>;
  retry(roleRecordId: string): Promise<RoleDeliveryState | undefined>;
  subscribe(listener: () => void): () => void;
};

export type HostDwnRecord = {
  readonly id: string;
  readonly contextId?: string;
  readonly creator: string;
  readonly recipient?: string;
  readonly module?: string;
  readonly modulePath?: string;
  readonly timestamp: string;
  readonly deleted: boolean;
};

export interface HostDwnApi {
  readonly connectedDid: string;
  readonly records: {
    query(request: {
      filter: {
        module?: string;
        modulePath?: string;
        contextId?: string;
        recipient?: string;
      };
    }): Promise<{
      status: { code: number; detail: string };
      records: HostDwnRecord[];
    }>;
    delete(request: {
      contextId?: string;
      module?: string;
      modulePath?: string;
      recordId: string;
    }): Promise<{
      status: { code: number; detail: string };
    }>;
  };
  withRecordExecutionContext(context: RecordExecutionContext): HostDwnApi;
}

export interface TypedEnboxHost<
  D extends ModuleDefinition = ModuleDefinition,
  C extends RecordCodecMap = RecordCodecMap,
> {
  readonly module: string;
  readonly definition: D;
  readonly graph: ResolvedModuleGraph;
  readonly dwn: HostDwnApi;
  readonly roleDelivery?: RoleDeliveryApiHost;
  ensureReady(path: string): Promise<void>;
  scope(options: ScopedRecordsOptions): object;
  readonly records: {
    create<Path extends ModulePaths<D> & string>(
      path: Path,
      request: {
        data: DataForPath<C, Path>;
        from?: string;
        parentContextId?: string;
        recipient?: string;
        dateCreated?: string;
        messageTimestamp?: string;
      },
    ): Promise<ContextRecord<DataForPath<C, Path>>>;
    query<Path extends ModulePaths<D> & string>(
      path: Path,
      request?: ContextRecordQuery,
    ): Promise<RecordPage<ContextRecord<DataForPath<C, Path>>>>;
    observe<Path extends ModulePaths<D> & string>(
      path: Path,
      request: ContextObserveRequest<D, Path, undefined>,
    ): Promise<ExpandableRecordView<ContextRecord<DataForPath<C, Path>>>>;
    subscribe(
      selection: (ModulePaths<D> & string) | readonly (ModulePaths<D> & string)[],
      options: Readonly<{ signal?: AbortSignal }>,
      listener: (event: RecordSubscriptionEvent<string, ContextRecord>) => void | Promise<void>,
    ): Promise<RecordSubscription>;
    delete<Path extends ModulePaths<D> & string>(
      path: Path,
      request: { recordId: string; within?: string; prune?: boolean },
    ): Promise<void>;
  };
}

export interface EnboxModulesHost {
  resolveGraph(module: TypedModule): ResolvedModuleGraph;
  resolveContextRoles(graph: ResolvedModuleGraph, path: string): readonly string[];
  resolveContextRoot(graph: ResolvedModuleGraph, root: ModuleContextRoot): ResolvedModuleNode;
  resolveRoleScope(graph: ResolvedModuleGraph, role: ResolvedRoleReference): ResolvedModuleRoleScope;
  definitionsEqual(left: unknown, right: unknown): boolean;
  representationsEqual(expected: ResolvedModuleNode, actual: ResolvedModuleNode): boolean;
}

export interface EnboxHost {
  readonly connectedDid: string;
  readonly signal: AbortSignal;
  readonly dwn: HostDwnApi;
  readonly modules: EnboxModulesHost;
  readonly agent: {
    readonly sync?: SyncEngineHost;
  };
  using(module: TypedModule): TypedEnboxHost;
}

// ---------------------------------------------------------------------------
// Public Shared-Context Surface Types
// ---------------------------------------------------------------------------

type ParentModulePath<Path extends string> = Path extends `${infer Head}/${infer Tail}`
  ? Tail extends `${string}/${string}` ? `${Head}/${ParentModulePath<Tail>}` : Head
  : never;

export type ContextInvitation<
  Context = unknown,
  Path extends string = string,
> = Readonly<{
  id: string;
  ownerDid: string;
  contextId: string;
  path: Path;
  preview: ContextInvitationPreview;
  timestamp: string;
  accept(): Promise<Context>;
  dismiss(): Promise<void>;
}>;

export type ContextInvitationsApi<
  Context = unknown,
  Path extends string = string,
> = Readonly<{
  list(options?: Readonly<{ limit?: number }>): Promise<ContextInvitation<Context, Path>[]>;
  observe(options?: Readonly<{ limit?: number; signal?: AbortSignal }>): Promise<
    RecordView<ContextInvitation<Context, Path>>
  >;
}>;

export type ContextMember<
  D extends ModuleDefinition = ModuleDefinition,
  C extends RecordCodecMap = RecordCodecMap,
  Role extends ModulePaths<D> & string = ModulePaths<D> & string,
> = Role extends string ? Readonly<{
  data: DataForPath<C, Role>;
  delivery: RoleDeliveryState;
  did: string;
  role: Role;
}> : never;

export type ContextMemberSetRequest<
  C extends RecordCodecMap,
  Role extends string,
> = Role extends string ? Readonly<{
  data: DataForPath<C, Role>;
  role: Role;
}> : never;

export type ContextMembersApi<
  D extends ModuleDefinition = ModuleDefinition,
  C extends RecordCodecMap = RecordCodecMap,
  Role extends ModulePaths<D> & string = ModulePaths<D> & string,
> = Readonly<{
  get(did: string): Promise<ContextMember<D, C, Role> | undefined>;
  list(): Promise<ContextMember<D, C, Role>[]>;
  observe(options?: Readonly<{ signal?: AbortSignal }>): Promise<RecordView<ContextMember<D, C, Role>>>;
  remove(did: string): Promise<void>;
  retryDelivery(did: string): Promise<ContextMember<D, C, Role> | undefined>;
  set<SelectedRole extends Role>(
    did: string,
    request: ContextMemberSetRequest<C, SelectedRole>,
  ): Promise<ContextMember<D, C, SelectedRole>>;
}>;

export type ContextModuleBinding<
  M extends TypedModule = TypedModule,
  OwningModuleUri extends string = string,
  OwningModulePath extends string = string,
> = Readonly<{
  module: M['definition']['module'];
  path: ModuleAttachmentPaths<M, OwningModuleUri, OwningModulePath>;
  records: ContextRecordsApi<M['definition'], M['codecs'], ModuleAttachmentPaths<M, OwningModuleUri, OwningModulePath>>;
}>;

type ContextBase<
  D extends ModuleDefinition = ModuleDefinition,
  C extends RecordCodecMap = RecordCodecMap,
  Root extends ModulePaths<D> & string = ModulePaths<D> & string,
> = {
  id: string;
  key: string;
  ownerDid: string;
  path: Root;
  records: ContextRecordsApi<D, C, Root>;
  using<M extends TypedModule>(module: M): ContextModuleBinding<M, D['module'], Root>;
  rootRecordId: string;
};

type MemberContextForRoot<
  D extends ModuleDefinition,
  C extends RecordCodecMap,
  Role extends ContextRolePath<D>,
  Root extends ModulePaths<D> & string,
> = Root extends unknown
  ? Readonly<ContextBase<D, C, Root> & {
    access: 'member';
    role: Role extends string ? ParentModulePath<Role> extends Root ? Role : never : never;
    leave(): Promise<void>;
    forget(): Promise<void>;
    refresh(): Promise<void>;
  }>
  : never;

export type OwnedContext<
  D extends ModuleDefinition = ModuleDefinition,
  C extends RecordCodecMap = RecordCodecMap,
  Root extends ModulePaths<D> & string = ModulePaths<D> & string,
> = Root extends unknown ? Readonly<
  ContextBase<D, C, Root> & { access: 'owner' } &
  ([ContextRolesAtPath<D, Root>] extends [never] ? Record<never, never> : {
    members: ContextMembersApi<D, C, ContextRolesAtPath<D, Root>>;
    invite(did: string, request?: Readonly<{ preview?: ContextInvitationPreview }>): Promise<void>;
  })
> : never;

export type MemberContext<
  D extends ModuleDefinition = ModuleDefinition,
  C extends RecordCodecMap = RecordCodecMap,
  Role extends ContextRolePath<D> = ContextRolePath<D>,
> = MemberContextForRoot<
  D,
  C,
  Role,
  Extract<ParentModulePath<Role>, ModulePaths<D> & string>
>;

export type ModuleContext<
  D extends ModuleDefinition = ModuleDefinition,
  C extends RecordCodecMap = RecordCodecMap,
> = OwnedContext<D, C, ContextRootPath<D>> | MemberContext<D, C>;

export type MaterializedMemberContext<
  Context = MemberContext,
  Root = ContextMaterializedRecord,
> = MaterializedMemberContextRow<Context, Root>;

type SelectedMaterializedMemberContext<
  D extends ModuleDefinition,
  C extends RecordCodecMap,
  Context = Extract<ModuleContext<D, C>, { access: 'member' }>,
> = Context extends { path: infer Path extends string }
  ? MaterializedMemberContext<Context, ContextMaterializedRecord<DataForPath<C, Path>>>
  : never;

export type ContextObserve<D extends ModuleDefinition, C extends RecordCodecMap> = {
  (options: Readonly<{ access: 'member'; materializeRoot: true; signal?: AbortSignal }>):
    Promise<ContextView<SelectedMaterializedMemberContext<D, C>>>;
  (options?: Readonly<{ signal?: AbortSignal }>):
    Promise<ContextView<ModuleContext<D, C>>>;
};

export type ContextFollowTarget = Readonly<{ id: string; ownerDid: string }>;

export type ContextFollow<D extends ModuleDefinition, C extends RecordCodecMap> = <Root extends ContextRootPath<D>>(
  path: Root,
  request: ContextFollowTarget,
) => Promise<MemberContext<D, C, ContextRolesAtPath<D, Root>>>;

export type ContextsApi<
  D extends ModuleDefinition = ModuleDefinition,
  C extends RecordCodecMap = RecordCodecMap,
> = Readonly<{
  withModules(modules: Readonly<Record<string, TypedModule>>): ContextsApi<D, C>;
  open<Root extends Exclude<ModulePaths<D> & string, ModuleRolePaths<D>>>(
    path: Root,
    id: string,
  ): Promise<OwnedContext<D, C, Root>>;
  follow: ContextFollow<D, C>;
  forget(request: ContextFollowTarget): Promise<void>;
  list(): Promise<ModuleContext<D, C>[]>;
  observe: ContextObserve<D, C>;
} & ([ContextRootPath<D>] extends [never] ? Record<never, never> : {
  invitations: ContextInvitationsApi<MemberContext<D, C>, ContextRootPath<D>>;
})>;
