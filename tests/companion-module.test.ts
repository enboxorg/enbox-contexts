import { describe, expect, it } from 'vitest';

import type { ModuleDefinition, RecordCodec, RecordDataReader, TypedModule } from '../src/index.js';
import {
  CONTEXT_FOLLOW_PATH,
  CONTEXT_INVITATION_PATH,
  contextFollowCodec,
  contextInvitationCodec,
  currentTimestamp,
  defineContextModule,
  isContextCompanionModule,
  moduleContextKey,
  timestampAfter,
} from '../src/index.js';

function jsonCodec<T>(): RecordCodec<T> {
  return {
    encode: value => ({
      data: new Blob([JSON.stringify(value)], { type: 'application/json' }),
      dataFormat: 'application/json',
    }),
    decode: async data => (await data.json()) as T,
  };
}

function makeRecordData(rawJson: string): RecordDataReader {
  const stream = async (): Promise<ReadableStream> => new ReadableStream();
  return {
    blob: async () => new Blob([rawJson], { type: 'application/json' }),
    bytes: async () => new TextEncoder().encode(rawJson),
    json: async () => JSON.parse(rawJson) as unknown,
    stream,
    text: async () => rawJson,
    then: (onFulfilled, onRejected) => stream().then(onFulfilled, onRejected),
    catch: (onRejected) => stream().catch(onRejected),
  };
}

function makeRootModule(uri = 'https://example.com/modules/notebooks/v1'): TypedModule<ModuleDefinition> {
  return {
    definition: {
      module: uri,
      published: true,
      types: {
        page: { dataFormats: ['application/json'] },
        member: { dataFormats: ['application/json'] },
      },
      structure: {
        page: {
          $actions: [{ role: 'page/member', can: ['read'] }],
          member: { $role: true },
        },
      },
    },
    codecs: {
      page: jsonCodec<{ title: string }>(),
      member: jsonCodec<{ label: string }>(),
    },
    dependencies: {},
  };
}

describe('defineContextModule & companion codecs', () => {
  it('creates an isolated, frozen companion module without mutating the root module', () => {
    const root = makeRootModule('https://example.com/modules/notebooks/v1/');
    const companion = defineContextModule(root);

    expect(companion.definition.module).toBe('https://example.com/modules/notebooks/v1/contexts');
    expect(companion.definition.published).toBe(true);
    expect(companion.root).toBe(root);
    expect(Object.isFrozen(companion)).toBe(true);
    expect(Object.isFrozen(companion.definition)).toBe(true);
    expect(Object.isFrozen(companion.codecs)).toBe(true);
    expect(isContextCompanionModule(companion)).toBe(true);
    expect(isContextCompanionModule(root)).toBe(false);

    expect(root.definition.structure).toEqual({
      page: {
        $actions: [{ role: 'page/member', can: ['read'] }],
        member: { $role: true },
      },
    });
    expect(companion.definition.structure[CONTEXT_INVITATION_PATH]).toEqual({
      $immutable: true,
      $size: { max: 8192 },
      $actions: [{ who: 'anyone', can: ['create'] }],
    });
    expect(companion.definition.structure[CONTEXT_FOLLOW_PATH]).toEqual({
      $immutable: true,
      $size: { max: 8192 },
    });
    expect(companion.definition.types[CONTEXT_FOLLOW_PATH].encryptionRequired).toBe(true);
  });

  it('supports custom companion URIs and rejects invalid inputs', () => {
    const root = makeRootModule('https://example.com/modules/notebooks/v1');
    const custom = defineContextModule(root, { module: 'https://example.com/modules/notebooks-collab/v1' });
    expect(custom.definition.module).toBe('https://example.com/modules/notebooks-collab/v1');

    expect(() => defineContextModule(root, { module: root.definition.module }))
      .toThrow('distinct from the root module URI');
    expect(() => defineContextModule(root, { module: '   ' }))
      .toThrow('non-empty string');
    expect(() => defineContextModule({} as TypedModule))
      .toThrow('expected a TypedModule');
  });

  it('strictly validates invitation and follow payloads on encode and decode', async () => {
    const validInvitation = {
      contextId: 'nb1/pg2',
      path: 'notebook/page',
      preview: { title: 'Sprint plan' },
    };
    const encodedInvite = await contextInvitationCodec.encode(validInvitation);
    expect(encodedInvite.dataFormat).toBe('application/json');
    expect(
      await contextInvitationCodec.decode(
        makeRecordData(await encodedInvite.data.text()),
        'application/json',
      ),
    ).toEqual(validInvitation);

    const invalidInviteJson = JSON.stringify({
      contextId: 'nb1/pg2',
      path: '$invalid/path',
      preview: { title: 'Bad' },
    });
    await expect(
      contextInvitationCodec.decode(makeRecordData(invalidInviteJson), 'application/json'),
    ).rejects.toThrow();

    const validFollow = {
      ownerDid: 'did:dht:alice123',
      contextId: 'nb1/pg2',
      following: true as const,
      path: 'notebook/page',
    };
    const encodedFollow = await contextFollowCodec.encode(validFollow);
    expect(
      await contextFollowCodec.decode(makeRecordData(await encodedFollow.data.text()), 'application/json'),
    ).toEqual(validFollow);

    const validForget = {
      ownerDid: 'did:dht:alice123',
      contextId: 'nb1/pg2',
      following: false as const,
    };
    const encodedForget = await contextFollowCodec.encode(validForget);
    expect(
      await contextFollowCodec.decode(makeRecordData(await encodedForget.data.text()), 'application/json'),
    ).toEqual(validForget);

    const malformedFollowJson = JSON.stringify({
      ownerDid: 'not-a-did',
      contextId: 'nb1/pg2',
      following: true,
      path: 'notebook/page',
    });
    await expect(
      contextFollowCodec.decode(makeRecordData(malformedFollowJson), 'application/json'),
    ).rejects.toThrow();
  });

  it('produces collision-safe keys and strictly monotonic microsecond timestamps', () => {
    expect(moduleContextKey('did:dht:a:b', 'c')).not.toBe(moduleContextKey('did:dht:a', 'b:c'));

    const t0 = currentTimestamp();
    expect(t0).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const future = '2099-12-31T23:59:59.999998Z';
    const next1 = timestampAfter(future);
    const next2 = timestampAfter(next1);
    expect(next1).toBe('2099-12-31T23:59:59.999999Z');
    expect(next2).toBe('2100-01-01T00:00:00.000000Z');
    expect(next2 > next1 && next1 > future).toBe(true);
  });
});
