# @enbox/contexts

Optional shared contexts, invitations, role membership management, and cross-device follow journals for Enbox applications.

`@enbox/contexts` pairs with `@enbox/api` or `@enbox/browser` while keeping `defineModule()` pure: domain modules never receive hidden `invitation` or `follow` structure paths. Instead, each application that wants managed collaboration defines an explicit companion module via `defineContextModule()` and binds it to an `Enbox` session via `bindContexts()`.

## Installation

```bash
bun add @enbox/contexts @enbox/browser
```

## Quick Start

### 1. Define your domain module and companion context module

```ts
import { defineModule, recordCodecs } from '@enbox/browser';
import { bindContexts, defineContextModule } from '@enbox/contexts';

export const NotebookModule = defineModule({
  definition: {
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
          member: {
            $role: true,
            $actions: [{ who: 'recipient', can: ['co-delete'] }],
          },
          viewer: {
            $role: true,
            $actions: [{ who: 'recipient', can: ['co-delete'] }],
          },
        },
      },
    },
  },
  codecs: {
    notebook: recordCodecs.json<{ name: string }>(),
    page: recordCodecs.json<{ summary: string }>(),
    title: recordCodecs.json<{ title: string }>(),
    member: recordCodecs.json<{ name: string }>(),
    viewer: recordCodecs.json<{ name: string }>(),
  },
});

// Companion module storing open-write invitations and encrypted follow/forget intent:
export const NotebookContextsModule = defineContextModule(NotebookModule);
```

Register both `NotebookModule` and `NotebookContextsModule` in `defineApplicationManifest({ modules: [NotebookModule, NotebookContextsModule] })` or `defineStore({ modules: { notebooks: NotebookModule, notebookContexts: NotebookContextsModule } })` so wallet grants remain isolated per application.

### 2. Share and follow contexts (including composed extensions)

```ts
const contexts = bindContexts(enbox, NotebookContextsModule).withModules({
  realtime: NotebookRealtimeModule,
});

// Owner workflow
const ownedPage = await contexts.open('notebook/page', pageRecord.contextId);
await ownedPage.members.set(aliceDid, {
  role: 'notebook/page/member',
  data: { name: 'Alice' },
});
await ownedPage.invite(aliceDid, {
  preview: { title: 'Launch plan' },
});

// Recipient workflow
const sharedPage = await contexts.follow('notebook/page', {
  ownerDid,
  id: pageRecord.contextId,
});
await sharedPage.refresh();

const realtime = sharedPage.using(NotebookRealtimeModule);
const liveView = await realtime.records.observe('page/live', {
  pagination: { limit: 1 },
});
```

### 3. Observe inside `defineStore`

```ts
const NotebookStore = defineStore({
  name: 'notebooks',
  modules: {
    notebooks: NotebookModule,
    notebookContexts: NotebookContextsModule,
  },
  create({ enbox, observe }) {
    const acceptedShares = observe(signal =>
      bindContexts(enbox(), NotebookContextsModule).observe({
        access: 'member',
        materializeRoot: true,
        signal,
      }),
    );
    return { acceptedShares };
  },
});
```

## License

Apache-2.0
