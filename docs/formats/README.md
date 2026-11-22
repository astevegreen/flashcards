# Data formats

The formats below are the app's public contract. Any build, past or future, should be able to read
data written in these formats, and anyone can write a compatible tool from these pages alone. This
is part of the sunset promise in [store-listing-and-sunset.md](../store-listing-and-sunset.md).

| Format       | What it is                                                                               | Spec                         |
| ------------ | ---------------------------------------------------------------------------------------- | ---------------------------- |
| `.flashpkg`  | Zip package for sharing decks, pages and courses, AI-generated content, and full backups | [flashpkg.md](./flashpkg.md) |
| `sync/v1/`   | Append-only event log that devices exchange through the user's own cloud folder          | [sync-v1.md](./sync-v1.md)   |
| Events       | The immutable change records stored in sync segments and replayed into app state         | [events.md](./events.md)     |
| JSON Schemas | Machine-readable schemas for package files and catalogs                                  | [schemas/](./schemas/)       |

The Zod schemas in `packages/content-schema/src/index.ts` are the source of truth for every
package and catalog file. `schemas/*.schema.json` is generated from them:

```sh
node scripts/export-schemas.mjs
```

Sample packages in this format live in [`content/samples/`](../../content/samples/README.md).
