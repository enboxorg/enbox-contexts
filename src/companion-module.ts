import type {
  EncodedRecordData,
  ModuleDefinition,
  RecordCodec,
  RecordCodecContext,
  RecordDataReader,
  TypedModule,
} from './host-types.js';

/** Canonical invitation inbox path inside a context companion module. */
export const CONTEXT_INVITATION_PATH = 'invitation' as const;

/** Canonical encrypted follow/forget journal path inside a context companion module. */
export const CONTEXT_FOLLOW_PATH = 'follow' as const;

const CONTEXT_ID_MAX_LENGTH = 600;
const CONTEXT_ID_PATTERN = /^[a-zA-Z0-9]+(?:\/[a-zA-Z0-9]+)*$/;
const DID_URI_PATTERN = /^did:[a-z0-9]+:[a-zA-Z0-9._:%-]+$/;

/** Small, non-sensitive application metadata displayed before a context is accepted. */
export type ContextInvitationPreview = Readonly<Record<string, string>>;

/** Data stored in one signed invitation record. */
export type ContextInvitationEnvelope = Readonly<{
  contextId: string;
  path: string;
  preview: ContextInvitationPreview;
}>;

/** One immutable recipient-owned decision to follow or forget a context. */
export type ContextFollowIntent = Readonly<{
  contextId: string;
  ownerDid: string;
} & (
  | {
    following: true;
    /** Module path of the context root; actual access is verified when restoring. */
    path: string;
  }
  | { following: false }
)>;

/** Definition shape generated for a companion context module. */
export type ContextCompanionDefinition = {
  readonly module: string;
  readonly published: true;
  readonly types: {
    readonly [CONTEXT_INVITATION_PATH]: {
      readonly schema: 'https://enbox.id/schemas/context-invitation';
      readonly dataFormats: ['application/json'];
    };
    readonly [CONTEXT_FOLLOW_PATH]: {
      readonly schema: 'https://enbox.id/schemas/context-follow';
      readonly dataFormats: ['application/json'];
      readonly encryptionRequired: true;
    };
  };
  readonly structure: {
    readonly [CONTEXT_INVITATION_PATH]: {
      readonly $immutable: true;
      readonly $size: { readonly max: 8192 };
      readonly $actions: [{ readonly who: 'anyone'; readonly can: ['create'] }];
    };
    readonly [CONTEXT_FOLLOW_PATH]: {
      readonly $immutable: true;
      readonly $size: { readonly max: 8192 };
    };
  };
};

/** Codec map carried by a companion context module. */
export type ContextCompanionCodecs = {
  readonly [CONTEXT_INVITATION_PATH]: RecordCodec<ContextInvitationEnvelope>;
  readonly [CONTEXT_FOLLOW_PATH]: RecordCodec<ContextFollowIntent>;
};

/**
 * A dedicated companion `TypedModule` holding an application's invitation inbox
 * and encrypted follow/forget journal while keeping the domain root module pure.
 *
 * Register both `rootModule` and this companion module in `defineApplicationManifest`
 * or `defineStore({ modules: { ... } })` so wallet grants remain isolated per dapp.
 */
export type ContextCompanionModule<Root extends TypedModule = TypedModule> = TypedModule<
  ContextCompanionDefinition,
  ContextCompanionCodecs
> & Readonly<{
  /** The domain root module whose contexts are coordinated by this companion module. */
  root: Root;
}>;

export type DefineContextModuleOptions = Readonly<{
  /**
   * Explicit URI for the companion module.
   * Defaults to `${rootModule.definition.module}/contexts`.
   */
  module?: string;
}>;

class CompanionRecordValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RecordValidationError';
  }
}

function createValidatedJsonCodec<T>(
  label: string,
  validator: (value: unknown) => value is T,
): RecordCodec<T> {
  const dataFormat = 'application/json';
  return Object.freeze({
    encode(value: T, _context?: RecordCodecContext): EncodedRecordData {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        throw new TypeError(`${label}: JSON values must be serializable.`);
      }
      const parsed: unknown = JSON.parse(serialized);
      if (!validator(parsed)) {
        throw new CompanionRecordValidationError(`${label}: value failed validation.`);
      }
      return {
        data: new Blob([serialized], { type: dataFormat }),
        dataFormat,
      };
    },
    async decode(data: RecordDataReader, _dataFormat: string, _context?: RecordCodecContext): Promise<T> {
      const parsed: unknown = await data.json();
      if (!validator(parsed)) {
        throw new CompanionRecordValidationError(`${label}: decoded record payload failed validation.`);
      }
      return parsed;
    },
  });
}

/** Validate one decoded invitation without trusting peer-authored application data. */
export function isContextInvitationEnvelope(value: unknown): value is ContextInvitationEnvelope {
  if (
    !isPlainObject(value)
    || !isValidContextId(value.contextId)
    || !isCanonicalModulePath(value.path)
    || !isPlainObject(value.preview)
  ) {
    return false;
  }
  return Object.values(value.preview).every(entry => typeof entry === 'string');
}

/** Validate stored intent coordinates before resolving its module context root. */
export function isContextFollowIntent(value: unknown): value is ContextFollowIntent {
  return isPlainObject(value)
    && isValidDidUri(value.ownerDid)
    && isValidContextId(value.contextId)
    && (value.following === false || (value.following === true && isCanonicalModulePath(value.path)));
}

export const contextInvitationCodec: RecordCodec<ContextInvitationEnvelope> = createValidatedJsonCodec(
  'contextInvitationCodec',
  isContextInvitationEnvelope,
);

export const contextFollowCodec: RecordCodec<ContextFollowIntent> = createValidatedJsonCodec(
  'contextFollowCodec',
  isContextFollowIntent,
);

/**
 * Create the companion `TypedModule` that stores open-write context invitations
 * and encrypted cross-device follow/forget intent for `rootModule`.
 */
export function defineContextModule<Root extends TypedModule>(
  rootModule: Root,
  options?: DefineContextModuleOptions,
): ContextCompanionModule<Root> {
  if (!isTypedModuleLike(rootModule)) {
    throw new TypeError('defineContextModule: expected a TypedModule created with defineModule().');
  }
  const baseUri = rootModule.definition.module.trim().replace(/\/+$/, '');
  if (baseUri.length === 0) {
    throw new TypeError('defineContextModule: root module URI must be a non-empty string.');
  }
  const moduleUri = options?.module === undefined ? `${baseUri}/contexts` : options.module.trim();
  if (moduleUri.length === 0) {
    throw new TypeError('defineContextModule: companion module URI must be a non-empty string.');
  }
  if (moduleUri === rootModule.definition.module) {
    throw new TypeError('defineContextModule: companion module URI must be distinct from the root module URI.');
  }

  const definition = Object.freeze({
    module: moduleUri,
    published: true,
    types: Object.freeze({
      [CONTEXT_INVITATION_PATH]: Object.freeze({
        schema: 'https://enbox.id/schemas/context-invitation',
        dataFormats: Object.freeze(['application/json']),
      }),
      [CONTEXT_FOLLOW_PATH]: Object.freeze({
        schema: 'https://enbox.id/schemas/context-follow',
        dataFormats: Object.freeze(['application/json']),
        encryptionRequired: true,
      }),
    }),
    structure: Object.freeze({
      [CONTEXT_INVITATION_PATH]: Object.freeze({
        $immutable: true,
        $size: Object.freeze({ max: 8192 }),
        $actions: Object.freeze([
          Object.freeze({ who: 'anyone', can: Object.freeze(['create']) }),
        ]),
      }),
      [CONTEXT_FOLLOW_PATH]: Object.freeze({
        $immutable: true,
        $size: Object.freeze({ max: 8192 }),
      }),
    }),
  }) as unknown as ContextCompanionDefinition;

  const codecs: ContextCompanionCodecs = Object.freeze({
    [CONTEXT_INVITATION_PATH]: contextInvitationCodec,
    [CONTEXT_FOLLOW_PATH]: contextFollowCodec,
  });

  return Object.freeze({
    definition,
    codecs,
    dependencies: Object.freeze({}),
    root: rootModule,
  });
}

/** Return the collision-safe identity for one owner-scoped module context. */
export function moduleContextKey(ownerDid: string, contextId: string): string {
  return JSON.stringify([ownerDid, contextId]);
}

/** Validate canonical W3C DID syntax without external runtime dependencies. */
export function isValidDidUri(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 7
    && value === value.trim()
    && DID_URI_PATTERN.test(value)
    && !value.endsWith(':');
}

/** Validate canonical DWN `contextId` segments and length. */
export function isValidContextId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= CONTEXT_ID_MAX_LENGTH
    && CONTEXT_ID_PATTERN.test(value);
}

/** Validate a slash-separated non-directive module path. */
export function isCanonicalModulePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.split('/').every(segment => segment !== '' && !segment.startsWith('$'));
}

/** Format an RFC-3339 UTC microsecond timestamp matching `@enbox/dwn-sdk-js` `Time`. */
export function currentTimestamp(): string {
  return formatMicrosecondTimestamp(BigInt(Date.now()) * 1000n);
}

/** Produce an RFC-3339 UTC microsecond timestamp strictly greater than `previous`. */
export function timestampAfter(previous: string): string {
  const nowMicros = BigInt(Date.now()) * 1000n;
  const parsed = parseMicrosecondTimestamp(previous);
  const nextMicros = parsed !== undefined && parsed >= nowMicros ? parsed + 1n : nowMicros;
  return formatMicrosecondTimestamp(nextMicros);
}

function parseMicrosecondTimestamp(timestamp: string): bigint | undefined {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(timestamp);
  if (!match) {
    return undefined;
  }
  const ms = Date.parse(`${match[1]}Z`);
  if (Number.isNaN(ms)) {
    return undefined;
  }
  const frac = (match[2] ?? '').padEnd(6, '0').slice(0, 6);
  return BigInt(ms) * 1000n + BigInt(frac);
}

function formatMicrosecondTimestamp(totalMicros: bigint): string {
  const millis = Number(totalMicros / 1000n);
  const subMillisMicros = Number(totalMicros % 1000n);
  const iso = new Date(millis).toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
  return `${iso.slice(0, -1)}${String(subMillisMicros).padStart(3, '0')}Z`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isTypedModuleLike(value: unknown): value is TypedModule<ModuleDefinition> {
  return isPlainObject(value)
    && isPlainObject(value.definition)
    && typeof value.definition.module === 'string'
    && isPlainObject(value.codecs)
    && isPlainObject(value.dependencies);
}

export function isContextCompanionModule(value: unknown): value is ContextCompanionModule {
  return isTypedModuleLike(value)
    && 'root' in value
    && isTypedModuleLike((value as { root: unknown }).root)
    && value.codecs[CONTEXT_INVITATION_PATH] === contextInvitationCodec
    && value.codecs[CONTEXT_FOLLOW_PATH] === contextFollowCodec;
}
