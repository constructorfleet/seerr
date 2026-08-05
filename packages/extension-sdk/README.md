# @seerr/extension-sdk

Types and the `defineExtension` helper for building [Seerr](https://github.com/seerr-team/seerr)
extensions.

This package contains **no runtime coupling to Seerr**. At runtime an extension receives an
`ExtensionSdk` object built by the host, backed by the host's own Express router, TypeORM
connection and winston logger. This package describes that object's shape and narrows it to what
your manifest declares.

## Install

```sh
npm install --save-dev @seerr/extension-sdk
```

A dev dependency, not a dependency: nothing here executes. Its own type dependencies
(`express`, `typeorm`, `winston`, `zod`) are **peer** dependencies, because at runtime the
extension shares the *host's* copies — a second installed TypeORM would give you a `Repository`
type that is nominally different from the one the SDK actually hands over.

The package version tracks the host API version, so `^1.0.0` here and `"apiVersion": "^1.0.0"`
in your manifest mean the same thing.

## An extension

Two files, at minimum.

`seerr-extension.json` at the package root:

```jsonc
{
  "id": "watch-history",
  "name": "Watch History",
  "version": "1.0.0",
  "apiVersion": "^1.0.0",
  "server": "dist/server.js",
  "requires": {
    "store": true,
    "media": "read"
  },
  "provides": {
    "permissions": [{ "key": "view_own", "name": "View Own History", "default": true }]
  }
}
```

And the entry point named by `server`:

```ts
import { defineExtension } from '@seerr/extension-sdk';
import type { ExtensionManifest } from '@seerr/extension-sdk';
import { WatchEvent } from './WatchEvent';

// Must agree with `seerr-extension.json`; see below for why it is not imported.
const manifest = {
  id: 'watch-history',
  name: 'Watch History',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  server: 'dist/server.js',
  requires: { store: true, media: 'read' },
  provides: {
    permissions: [{ key: 'view_own', name: 'View Own History', default: true }],
  },
} as const satisfies ExtensionManifest;

export = defineExtension({
  manifest,
  entities: [WatchEvent],
  setup(sdk) {
    // `store` and `media` are non-optional here, because the manifest declares them.
    sdk.router.get('/history', { permission: 'view_own' }, async (req, res) => {
      const events = await sdk.store.getRepository(WatchEvent).find({
        where: { userId: req.user!.id },
      });

      res.json(events);
    });

    sdk.events.on('media.available', async ({ media }) => {
      sdk.logger.info(`${media.tmdbId} became available`);
    });
  },
});
```

`export =`, not `export default`. The loader reads `module.exports.default` for the setup
function and `module.exports.entities` for the entities; `export default defineExtension(...)`
nests both one level too deep and puts an object where the loader looks for a function.

**Do not `import manifest from '../seerr-extension.json'`,** tempting as it is. `resolveJsonModule`
widens as it infers: a JSON `true` becomes `boolean`, `"read"` becomes `string`, and an array
becomes `T[]` rather than a tuple. Every conditional in `DeclaredCapability` then fails to match,
so an imported JSON manifest narrows **nothing** — `sdk.store` stays `ExtensionStore | undefined`
and you are back to `sdk.store!`. Worse, it does so silently: nothing errors, you just lose the
guarantee you came for.

So the manifest is written twice, and `as const satisfies ExtensionManifest` is what makes the
copy narrow — `satisfies` rather than a `: ExtensionManifest` annotation, which would widen the
literal types the narrowing reads, and `as const` so nested values stay literal. Keeping the two
in agreement is then your job; the reference extension does it with a test that asserts the built
literal is deep-equal to the JSON the host reads (`examples/watch-history` in the Seerr
repository).

## What `defineExtension` infers

The gated members of `ExtensionSdk` are optional in the host contract, because the loader
attaches only the ones your manifest asked for. Given the manifest as a literal type,
`defineExtension` recovers the guarantee:

| Manifest                                       | Effect on `sdk`                     |
| ---------------------------------------------- | ----------------------------------- |
| `requires.store: true`                         | `sdk.store` is non-optional         |
| `requires.jobs: true`                          | `sdk.jobs` is non-optional          |
| `requires.users: 'read' \| 'write'`            | `sdk.users` is non-optional         |
| `requires.media: 'read' \| 'write'`            | `sdk.media` is non-optional         |
| `requires.requests: 'read' \| 'write'`         | `sdk.requests` is non-optional      |
| `requires.settings: 'read'`                    | `sdk.settings` is non-optional      |
| `provides.notifications` with ≥ 1 entry        | `sdk.notify` is non-optional        |
| anything not declared                          | **absent from the type**            |

`id`, `logger`, `router` and `events` are always present.

Undeclared capabilities are removed rather than left optional on purpose. An optional member
turns a forgotten `requires.users` into a silent `sdk.users?.get(id)` that never runs; an absent
one makes it a compile error.

### What it does not infer

- **Nothing about your keys.** `sdk.jobs.register('sync', fn)` is not checked against
  `provides.jobs[].id`, and a route's `permission: 'view_own'` is not checked against
  `provides.permissions[].key`. Both are enforced at runtime — the loader throws on an
  undeclared job id, and `notify.send` throws on an undeclared notification key. Threading those
  literal unions through the types would mean parameterizing the whole `ExtensionSdk` on the
  manifest, for a check the host already makes.
- **Nothing from `http`, `version`, `apiVersion` or `id`.**
- **Nothing at all from a widened manifest.** If you write
  `const manifest: ExtensionManifest = { ... }`, the literal types are erased and no capability
  is inferred. Use `satisfies ExtensionManifest`, or pass the object straight to
  `defineExtension`, or import the JSON.

## Entity and migration rules

Every table an extension owns must be named `ext_<your-id>_*`. Migrations run against a
connection whose query runner rejects statements touching anything outside that prefix, and
they are tracked in their own `ext_<your-id>_migration` table rather than in Seerr's.

`entities` and `migrations` are read at **discovery**, before the database connection is
initialized, which is why they are properties of the module rather than something `setup`
registers. TypeORM cannot register an entity after `initialize()`.

For small state — a cursor, a last-run timestamp — use `sdk.store.kv` instead of declaring a
table.

## Publishing

An extension is installed by an operator from an npm package name or a git repository URL. In
both cases what is installed is what you publish or commit: **install runs no build step and no
lifecycle scripts**. Ship the compiled `server` entry point and any panel bundles.

For npm, make sure your built output is in `files`. For git, commit it.

## Types

Seerr's own entity types (`Media`, `MediaRequest`, `User`) are re-declared here structurally as
`SeerrMedia`, `SeerrMediaRequest` and `SeerrUser`, describing the persisted column surface. Seerr
is not a published package, so there is nothing to depend on for the real classes; the host
passes you real instances, which satisfy these interfaces. A conformance typecheck in the Seerr
repository fails if the two ever disagree.

Core permission values are exported as `SeerrPermission`, an `as const` object rather than an
`enum`, so its values are assignable to and from the host's `Permission` enum.

## Trust model

Extensions are **trusted code**. They are `require()`d into the Seerr process and receive an SDK
object; the manifest's `requires` shapes what that object contains, but it is capability hygiene,
not a sandbox. Installing an extension is equivalent in risk to `npm install` of anything else.
`requires.http` is documented and advisory in v1 — nothing enforces it.

## License

MIT
