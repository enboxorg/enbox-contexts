import type {
  ContextRecordsApi,
  ContextRolePath,
  ContextRolesAtPath,
  ContextRootPath,
  EnboxHost,
  ModuleAttachmentPaths,
  ModuleDefinition,
  RecordCodec,
  TypedModule,
} from '../src/index.js';
import { bindContexts, defineContextModule } from '../src/index.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

function jsonCodec<T>(): RecordCodec<T> {
  return {
    encode: value => ({
      data: new Blob([JSON.stringify(value)], { type: 'application/json' }),
      dataFormat: 'application/json',
    }),
    decode: async data => (await data.json()) as T,
  };
}

function makeModule<const D extends ModuleDefinition, C extends Record<string, RecordCodec<unknown>>, Deps extends Record<string, TypedModule> = Record<string, never>>(
  definition: D,
  codecs: C,
  dependencies?: Deps,
): TypedModule<D, C, Deps> {
  return {
    definition,
    codecs,
    dependencies: (dependencies ?? {}) as Deps,
  };
}

const EncryptedNotebook = makeModule(
  {
    module: 'https://example.com/modules/notebooks/v1',
    published: true,
    types: {
      notebook: { dataFormats: ['application/json'] },
      page: { dataFormats: ['application/json'], encryptionRequired: true },
      title: { dataFormats: ['application/json'], encryptionRequired: true },
      change: { dataFormats: ['application/json'], encryptionRequired: true },
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
            $actions: [{ role: 'notebook/page/member', can: ['read', 'co-update'] }],
          },
          change: {
            $squash: true,
            $actions: [{ role: 'notebook/page/member', can: ['create', 'read'] }],
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
    change: jsonCodec<{ delta: string }>(),
    member: jsonCodec<{ label: string }>(),
    viewer: jsonCodec<{ label: string }>(),
  },
);

const _PlaintextEvents = makeModule(
  {
    module: 'https://example.com/modules/events/v1',
    published: true,
    types: {
      event: { dataFormats: ['application/json'] },
      organizer: { dataFormats: ['application/json'] },
    },
    structure: {
      event: {
        $actions: [{ role: 'event/organizer', can: ['read'] }],
        organizer: { $role: true },
      },
    },
  },
  {
    event: jsonCodec<{ title: string }>(),
    organizer: jsonCodec<{ handle: string }>(),
  },
);

const RealtimeExtension = makeModule(
  {
    module: 'https://example.com/modules/notebooks/realtime/v1',
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
          $actions: [{ role: 'core:notebook/page/member', can: ['read', 'co-update'] }],
        },
      },
    },
  },
  {
    live: jsonCodec<{ relay: string }>(),
  },
  { core: EncryptedNotebook },
);

export type _EncryptedRoots = Expect<Equal<ContextRootPath<typeof EncryptedNotebook.definition>, 'notebook/page'>>;
export type _EncryptedRoles = Expect<
  Equal<ContextRolesAtPath<typeof EncryptedNotebook.definition, 'notebook/page'>, 'notebook/page/member' | 'notebook/page/viewer'>
>;
export type _PlaintextRoots = Expect<Equal<ContextRootPath<typeof _PlaintextEvents.definition>, 'event'>>;
export type _PlaintextRolePath = Expect<Equal<ContextRolePath<typeof _PlaintextEvents.definition>, 'event/organizer'>>;
export type _AttachmentPath = Expect<
  Equal<ModuleAttachmentPaths<typeof RealtimeExtension, 'https://example.com/modules/notebooks/v1', 'notebook/page'>, 'page'>
>;
export type _UnattachedIsNever = Expect<
  Equal<ModuleAttachmentPaths<typeof RealtimeExtension, 'https://example.com/modules/notebooks/v1', 'notebook'>, never>
>;

// Fix #9: Widened Root = string preserves concrete descendant paths rather than collapsing to `never`.
declare const widenedRecords: ContextRecordsApi<
  typeof EncryptedNotebook.definition,
  typeof EncryptedNotebook.codecs,
  string
>;
void widenedRecords.create('notebook/page/change', { data: { delta: 'ok' }, squash: true });
void widenedRecords.set('notebook/page/title', { data: { title: 'Hello' } });
// @ts-expect-error role paths are excluded from ContextRecordsApi
void widenedRecords.create('notebook/page/member', { data: { label: 'Alice' } });

export async function verifyBindContextsSurface(enbox: EnboxHost): Promise<void> {
  const companion = defineContextModule(EncryptedNotebook);
  const contexts = bindContexts(enbox, companion).withModules({ realtime: RealtimeExtension });

  const owned = await contexts.open('notebook/page', 'nb1/pg1');
  await owned.members.set('did:dht:alice', { role: 'notebook/page/member', data: { label: 'Alice' } });
  await owned.invite('did:dht:alice', { preview: { title: 'Roadmap' } });
  // @ts-expect-error cannot create another root inside a bound context
  await owned.records.create('notebook/page', { data: { summary: 'dup' } });
  await owned.records.set('notebook/page/title', { data: { title: 'Roadmap' } });

  const shared = await contexts.follow('notebook/page', { ownerDid: 'did:dht:owner', id: 'nb1/pg1' });
  const role: 'notebook/page/member' | 'notebook/page/viewer' = shared.role;
  void role;
  const realtime = shared.using(RealtimeExtension);
  const pathCheck: 'page' = realtime.path;
  void pathCheck;
  await realtime.records.set('page/live', { data: { relay: 'wss://nostr-1.fly.dev' } });

  const inbox = await contexts.invitations.list();
  if (inbox[0] !== undefined) {
    const accepted = await inbox[0].accept();
    await accepted.refresh();
  }
}
