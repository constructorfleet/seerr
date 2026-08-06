# Extension System

## Summary

A first-party extension ("plugin") system, modeled on Home Assistant add-ons. Extensions are
installed from npm or a git repo, declare what they need and provide in a manifest, and can
contribute:

- **Panels** — React views reachable from the sidebar, loaded at runtime without rebuilding Seerr.
- **API routes** — namespaced under `/api/v1/ext/:extensionId/*`.
- **Permissions** — their own permission set, per-user, independent of core's `Permission` enum.
- **Notifications** — their own event types, delivered through the existing notification agents.
- **Persistent storage** — their own tables, kept out of core's schema.
- **Scheduled jobs** — cron-scheduled work alongside core's jobs.

Reference extensions used to validate the design throughout: **Unrequest** (a user withdraws
media they requested) and **Watch History** (tracks per-user watch events).

## Trust model

**Extensions are trusted code.** They are `require()`d into the Seerr process and receive an SDK
object. Manifest declarations are enforced at the SDK boundary — the SDK a given extension
receives has only the capabilities its manifest asked for — but this is *capability hygiene, not a
security boundary*: an extension can bypass it with a raw `require('@server/datasource')`. Panel
bundles likewise execute in the user's browser session with full DOM and cookie access.

The threat model is therefore identical to `pnpm add <anything>`: trust is established at install
time, by the operator. This is a deliberate choice for v1 (it keeps the SDK a plain function-call
surface and lets extensions share TypeORM entities), and it is the single most important thing to
document for operators. Process isolation via RPC is the natural v2 if that trust model proves
too loose; the SDK is deliberately shaped as an interface so it could be backed by an RPC client
later without changing extension code.

## Constraints discovered in the codebase

These four shape the whole design. Each was verified, not assumed.

### 1. `Permission` has exactly one free bit

`server/lib/permissions.ts` tops out at `VIEW_BLOCKLIST = 1073741824` (bit 30). `hasPermission`
uses JS `&`, which coerces to signed int32, so **bit 31 (`2147483648`) is unusable**. Only bit 0
(value `1`) remains — `grep` confirms nothing references it.

An extension system that allocated core permission bits would exhaust the enum after one
extension. **Extensions therefore get a separate string-keyed permission space** (below) and the
core enum is not touched at all.

### 2. Core notification prefs are install-dependent if extensions add enum bits

`Notification` (`server/lib/notifications/index.ts:6-24`) tops out at
`MEDIA_AUTO_REQUESTED = 4096` (bit 12), so bits are *not* scarce here. (An earlier draft said bit 16,
`MEDIA_REMOVAL_AUTO_APPROVED` — that was written against the media-removal branch, which is not part
of this work.) The problem is
different: `ALL_NOTIFICATIONS` (`server/entity/UserSettings.ts:13-15`) is computed by **summing
every enum value at import time**, and is persisted per user as a resolved integer in
`user_settings.notificationTypes` (`:94`, `:101`, `:117`, `:121`).

If extensions contributed enum members, `ALL_NOTIFICATIONS` would change value depending on which
extensions are installed. Uninstalling one leaves every user with a saved mask containing a bit
that now means nothing — or worse, means a *different* extension's event after a reinstall in a
different order. **Extensions therefore get string-keyed notification types with their own
subscription storage**, which is stable across install/uninstall.

### 3. The OpenAPI validator rejects undocumented paths

`server/index.ts:226-231` mounts `OpenApiValidator.middleware({ apiSpec, validateRequests: true })`
globally, before `server.use('/api/v1', routes)`. There is no `ignoreUndocumented` or
`ignorePaths` option configured (verified by grep), and every currently mounted route is present
in `seerr-api.yml` (spot-checked `/settings/discover`, `/status/appdata`, `/backdrops`,
`/regions`, `/settings/notifications/pushover/sounds` — all present).

Extension routes cannot be in `seerr-api.yml`, since they are unknown at build time. **The
extension router must therefore mount *before* the validator middleware** in `server/index.ts`.
This is the one core-server change the whole design requires, and it needs a comment saying why,
because it looks like a mistake.

Consequence: extension routes get **no request validation for free**. The SDK compensates by
accepting an optional zod schema per route and validating before the handler runs (`zod@4.3.6` is
already a dependency).

### 4. Next.js Pages Router bundles pages at build time

`src/pages` is the Pages Router (`_app.tsx`, `[movieId]` dynamic segments). Pages are enumerated
at build time, so an extension installed into a running Docker container cannot contribute a page
the normal way. Hence the runtime bundle-loading design below.

## Design decisions

### Panels: runtime-loaded ESM bundles

A single catch-all page `src/pages/extensions/[...slug].tsx` resolves the extension and panel from
the route, then `import()`s the extension's pre-built ESM bundle from
`/api/v1/ext/:extensionId/ui/:file`. The panel default-exports a React component.

React, `react-dom`, `react-intl`, and `swr` are **shared, not bundled** — an extension that
bundled its own React would break hooks the moment its panel rendered inside Seerr's tree. The
SDK's build preset marks them external, and the host provides them to the bundle.

**This was spiked and answered. The import map and the host-provided global are not alternatives —
the working design is both, composed.** The prototype is kept at `docs/specs/spike-panels/`
(`extensionShared.ts` plus the two illustrative patches); slice 6 should start from it rather than
re-deriving it. An earlier draft of this spec framed them as a choice and
said to prefer the global "unless the import map proves easy"; that was a false choice. The global
is the mechanism that actually shares React; the import map is what keeps extension source
idiomatic (a bare `import 'react'`) instead of requiring the build preset to rewrite specifiers.

How it works, and why each half is load-bearing:

1. `_app.tsx` publishes its own already-bundled module namespaces at **module scope**:
   `window.__seerr_shared__ = { react: React, 'react-dom': ReactDOM, 'react/jsx-runtime': …, … }`.
2. The import map in `_document.tsx` points each bare specifier at a small generated ESM **shim**
   served by the host, and each shim re-exports from that global.

The shim is not optional plumbing, for two verified reasons:

- **React 19.2.6 ships no ESM at all.** Its `package.json` has no `module` field and no `import`
  condition; every `exports` entry resolves to CJS. An import map pointing at
  `/node_modules/react/index.js` serves a file the browser cannot execute.
- **Next never emits `type="module"`** (`next/dist/pages/_document.js`, `getScripts()` — the only
  `noModule` is the legacy polyfill). So an import map has *no effect whatsoever* on Next's own
  React. Bridging to the global is the only way the panel and the host land on one instance.

The trap this avoids: `react.production.js` contains **zero** `require()` calls, so it is trivial to
wrap into loadable ESM. That loads and renders fine — as a **second instance**. It fails only on
hooks. Any verification of this mechanism must therefore exercise a hook and assert identity
against the host, not merely that a panel renders. The spike's negative control did exactly that
and failed with the null-dispatcher error, which is what makes its positive results trustworthy.

Two non-obvious findings for slice 6:

- **`react/jsx-dev-runtime` cannot be a mechanical re-export.** A dev-built panel imports `jsxDEV`,
  but the host's production jsx-runtime exports only `{ Fragment, jsx, jsxs }` — verified, zero
  `jsxDEV`. Mapping the dev specifier onto the prod runtime yields `jsxDEV === undefined` and the
  panel dies on its first element. It needs a hand-written signature adapter.
- **Namespace objects are not identical** (`import * as ns` from a shim !== the host's namespace),
  because a shim is a distinct ES module. Every *binding* is identical, which is what matters — but
  an implementation that asserts namespace identity will fail.

The import map must be **exhaustive**: mapping `react-dom` does not map `react-dom/client`, and an
unmapped bare specifier rejects at link time. Shims are served above the OpenAPI validator for the
same reason `/api/v1/ext` is (constraint 3 applies to the shim route too — this was hit live), and
their URL should carry a build tag so a Seerr upgrade busts the cache.

Panels receive a client SDK prop: `{ user, hasPermission, api, fetcher, notify, intl, panel }`, where
`api` is an axios instance pre-scoped to `/api/v1/ext/<id>/` so the extension cannot accidentally call
core endpoints, and inherits the app's CSRF cookie behavior (`XSRF-TOKEN`, `server/index.ts:194-200`).

`fetcher` is an SWR fetcher over that instance, and must be passed explicitly:
`useSWR('/items', sdk.fetcher)`. `swr` is a shared specifier, so a panel gets the host's instance —
but the host's *global* fetcher is configured for core's `/api/v1` routes, so a bare
`useSWR('/items')` requests the wrong URL. SWR resolves a fetcher per hook call and there is no way
to rebind the shared instance's default for one subtree without changing it for the host too.

### `@seerr/extension-ui`

**A panel cannot style itself with Tailwind.** It is a pre-built bundle, so the host's Tailwind build
never sees its class names — `content` in `tailwind.config.js` globs only `./src/pages/**` and
`./src/components/**`, and JIT emits nothing it did not find there. A panel writing
`className="gap-7"` gets a class that does not exist: it renders unstyled, with no error anywhere.
Verified against the built CSS — `ring-gray-700` and `rounded-xl` are present only because host
source happens to use them; `gap-7` is absent. The semantic classes in `globals.css` (`.heading`,
`.description`, `.card-field`) *are* safe, being hand-written rather than generated.

The fix is a second shared specifier, `@seerr/extension-ui`, resolving to the host's own components
(`src/components/ExtensionUi/index.ts`, listed in `server/lib/extensions/uiComponents.ts`). Their
classes are compiled because they live under `src/components/**`, so a panel using them cannot have
missing CSS, and a retheme reaches every panel at once.

Three components in `Common/` are deliberately excluded — `ListView`, `QuickConnectModal` and
`SettingsTabs` — because they take host-page-specific props rather than being part of the visual
language.

Components do not remove the hazard for the layout classes a panel still writes around them, and it
is worth knowing how to check those, because nothing else will tell you. Extract every `className`
from the **built** panel bundle and grep each one against the host's built stylesheet, escaping the
way Tailwind does (`sm:w-96` appears as `.sm\:w-96`). Doing this to the media-removal panel found a
real bug that had already shipped: its deletion-confirmation sentence asked for `text-red-400`, a
shade host source never uses, so no CSS existed for it and the warning rendered in the card's
inherited gray. `text-red-300` and `text-red-500` are both present — the difference is only which
shades the host happens to use, which is exactly why this cannot be reasoned about and has to be
checked. Note the check must run against the built bundle rather than the source, since that is what
the browser loads.

The published package's declarations are **generated** from host source
(`packages/extension-ui/bin/generateTypes.mjs`), not hand-written. This is the opposite choice from
`@seerr/extension-sdk`, which re-declares the host contract and pins the copy with a conformance
typecheck; that works there because the surface is small and stable. Here it is 25 components' React
prop types, mostly unexported, one a generic over `React.ElementType` — so re-declaration would be
both large and a silent drift surface. Generation emits the declarations and rewrites `@app/*` and
`@server/*` specifiers to relative paths, since an extension is built outside this repo and has no
aliases. `server/lib/extensions/uiPackage.test.ts` pins that the rewrite is complete, which is the
one failure this repo cannot otherwise notice: an unrewritten alias typechecks *here*, where the
paths exist, and breaks only in an author's build.

Rejected: build-time integration (requires a rebuild per install — fails the "add via npm/git"
requirement in a Docker deployment) and iframe ingress (panels would not match the design system,
and every navigation/toast needs cross-frame messaging).

### Storage: namespaced tables in the main database

Extension entities are registered into the **main** DataSource with table names prefixed
`ext_<extensionId>_*`. This was the user's explicit preference over separate databases, and it is
the right call: both reference extensions are dominated by lookups against `user` and `media`
(Watch History is *entirely* `userId`/`mediaId` rows), and a separate database means no foreign
keys and an N+1 through the SDK for every join. One backup covers everything, and it works
identically on sqlite and Postgres.

Note this contradicts the original "keep extension data out of the seerr data store" framing.
What is preserved is the *intent* — extension tables are namespaced, owned, and dropped on
uninstall, and core migrations never touch them. What is given up is physical separation: a buggy
extension migration runs against the core database. Mitigations in "Migration safety" below.

**Table prefixes, not a Postgres schema per extension.** A real schema would force
dialect-divergent entity definitions; prefixes keep one definition working on both, the same
reason `DbAwareColumn`/`resolveDbType` (`server/utils/DbColumnHelper.ts`) exists.

**Extension loading is two-phase, because TypeORM cannot register entities after
`initialize()`.** `DataSource.entityMetadatas` is `readonly` and metadata is built during
`initialize()`, so extension entities must be present in the initial `entities` array. Verified:
`DataSource.setOptions(options: Partial<DataSourceOptions>)` exists and can inject them
beforehand. Boot therefore becomes:

1. **Discover** — read manifests, validate, load entity classes. No DB access yet.
2. `dataSource.setOptions({ entities: [...core, ...extensionEntities] })` then `initialize()`.
3. Run extension migrations (below).
4. **Activate** — build each extension's SDK and call its entry point.

This splits the loader (slice 3) into a pre-DB discovery phase and a post-DB activation phase, and
it constrains where the loader is called from in `server/index.ts` — discovery must precede
`dataSource.initialize()` at `:67-69`, activation must follow it.

**Migration tracking must not pollute core's `migrations` table.** At boot, each extension with
pending migrations gets a short-lived DataSource configured with
`migrationsTableName: 'ext_<id>_migration'`, pointed at the same database, whose migrations are
run and which is then `destroy()`ed. Runtime queries all go through the main DataSource. Sequential,
not parallel — concurrent sqlite writers contend.

### Permissions: string-keyed, per-user, extension-owned

Extensions declare permissions in their manifest with local keys; the system namespaces them as
`<extensionId>:<key>`.

```
ext_permission (core-owned table)
  userId      integer  FK → user.id ON DELETE CASCADE
  permission  varchar  e.g. 'unrequest:remove_own'
  PRIMARY KEY (userId, permission)
```

Rows, not a bitmask — unbounded, and an uninstalled extension's rows are inert rather than
ambiguous.

Resolution rules, which must match on server and client:

- Core `Permission.ADMIN` grants every extension permission. Matches `hasPermission`'s existing
  short-circuit (`permissions.ts:61-63,74`) and avoids an admin locked out of an extension.
- A manifest permission may declare `requiresCore` (e.g. Unrequest's `remove_own` requires
  `Permission.REQUEST`), enforced server-side and reflected in the editor UI, mirroring the
  existing `requires` field on `PermissionItem` (`src/components/PermissionOption/index.tsx:12-18`).
- Manifest permissions may declare `default: true` to be granted to new users.

The user-edit UI gains a per-extension section below `permissionList`
(`src/components/PermissionEdit/index.tsx:109`). `PermissionItem.permission` is typed
`Permission` (a number), so extension entries need a discriminated variant rather than a cast —
plan on widening that type.

### Notifications: string-keyed types over the existing agents

Extensions declare notification types in the manifest (`key`, `name`, `description`, `default`).
The system namespaces them `<extensionId>:<key>` and stores subscriptions per user in
`ext_notification_subscription (userId, notificationType, agents)`, where `agents` is a JSON
array of `NotificationAgentKey`. Deliberately *not* the core bitmask, per constraint 2.

`sdk.notify.send(key, payload)` builds a `NotificationPayload` and routes it through the existing
`notificationManager` so extension notifications reach every configured agent (Discord, email,
webpush, …) with no per-agent code.

The per-agent `switch (type)` blocks are the friction point. Each agent maps a `Notification` enum
value to a subject/label; an extension event has no enum value. Approach: extend
`NotificationPayload` with an optional `extensionEvent?: { id, key, name }` and have agents fall
back to it for display when `type` is a new sentinel `Notification.EXTENSION` (a single new core
enum member — **bit 13, `8192`**, as shipped — and it keeps `ALL_NOTIFICATIONS` install-independent
because it does not vary with what is installed). Since this bit is *persisted* in every user's saved
mask, pick it once and never renumber it; on a branch that adds its own notification types the value
would differ, which is a merge hazard worth resolving deliberately.

Agents that already render generically need no change: `webhook.ts` reverse-maps `Notification[type]`
and reads `templateSource` (`webhook.ts:22-27`). Two needed fixing, and the second is a bug this spec
originally missed:

- `webpush.ts` has a `default:` branch that renders `subject: 'Unknown'` — without a fallback every
  extension push is unlabeled.
- `email.ts`'s `buildMessage` has **no** `default:`: a payload with neither `request` nor `issue`
  falls through to `return undefined`, so the notification is **silently dropped**, not mislabeled.
  Fixed with an early branch and a dedicated `templates/email/extension` template.

One more core change was unavoidable: `NotificationManager.sendNotification` iterated agents with
`forEach` and a bare `agent.send()`, so an agent throwing synchronously aborted the loop and skipped
every agent after it, and a rejected send became an unhandled rejection. Core only ever fans out
once, which is why this was latent; an extension notification fans out per subscriber and makes it
reachable. Now each agent is isolated with a try/catch plus a `.catch()`.

**Client divergence.** `src/components/NotificationTypeSelector/index.tsx` duplicates the enum and
computes its own `ALL_NOTIFICATIONS`, which now lags the server's (8190 vs 16382). Toggling is
per-bit additive so unknown bits survive edits, but `UserNotificationsEmail.tsx:64` and
`UserNotificationsWebPush/index.tsx:252` fall back to the client constant when the server returns no
saved value, so a user who has never saved settings gets the extension bit off. Slice 8 owns this UI
and must add the sentinel.

`public/sw.js` string-compares `notificationType` for actions/badging (`:97`, `:113-114`, `:123`);
extension pushes will fall through its branches harmlessly, but confirm no crash on an unknown type.

### Install: resolve, stage, verify, register

`npm`/git installs are performed **out of process** into `${CONFIG_DIRECTORY:-config}/extensions/<id>/`,
never into Seerr's own `node_modules` (an extension must not be able to change Seerr's dependency
tree). Install is an explicit admin action; **nothing is installed automatically at boot** — boot
only loads what is already present and enabled.

`sdk`-declared `apiVersion` is checked against the host's with `semver` (already a dependency,
`7.7.4`); a mismatch refuses to load the extension rather than crashing later. A failed extension
load must be caught, logged, surfaced in the admin UI as unhealthy, and **must not prevent Seerr
from starting** — one bad extension bricking a server is the worst failure mode here.

## Manifest

`seerr-extension.json` at the extension root, validated with zod at load time.

```jsonc
{
  "id": "watch-history",              // ^[a-z][a-z0-9-]*$ — namespaces tables, routes, perms
  "name": "Watch History",
  "version": "1.0.0",
  "apiVersion": "^1.0.0",             // host SDK compatibility, semver range
  "server": "dist/server.js",         // entry: default-exports (sdk) => void | Promise<void>
  "requires": {                       // capabilities → shapes the SDK object handed over
    "users": "read",                  // 'read' | 'write'
    "media": "read",                  // 'write' additionally grants sdk.media.remove
    "requests": "read",
    "discover": "read",              // TMDB trending/recommendations/similar, 'read' only
    "tautulli": "read",              // core's Tautulli watch history, 'read' only
    "settings": "read",
    "store": true,
    "jobs": true,
    "http": ["plex.tv"]               // outbound allowlist, advisory in v1
  },
  "provides": {
    "permissions": [
      { "key": "view_own", "name": "View Own History", "default": true },
      { "key": "view_all", "name": "View All History",
        "requiresCore": ["MANAGE_USERS"] }
    ],
    "notifications": [
      { "key": "milestone", "name": "Watch Milestone", "default": false }
    ],
    "panels": [
      { "slug": "history", "title": "Watch History", "entry": "dist/panel.js",
        "sidebar": { "icon": "ClockIcon", "order": 50 },
        "permission": "view_own" }
    ],
    "jobs": [
      { "id": "sync", "name": "Sync Watch History", "schedule": "0 */6 * * *" }
    ],
    "settings": [                     // operator-editable; the host renders the form
      { "key": "endpoint", "type": "string", "name": "Plex Endpoint",
        "required": true },
      { "key": "batch_size", "type": "number", "name": "Batch Size",
        "default": 25, "min": 1, "max": 100 },
      { "key": "mode", "type": "select", "name": "Source", "default": "plex",
        "options": [ { "value": "plex", "label": "Plex" } ] },
      { "key": "api_token", "type": "secret", "name": "API Token" }
    ]
  }
}
```

`sidebar.icon` is a name from `@heroicons/react/24/outline`, resolved against an explicit allowlist
map — not a dynamic import of an arbitrary string. The allowlist is
`server/lib/extensions/panelIcons.ts`, and the manifest schema validates against that same list, so
naming an icon the sidebar cannot draw is a manifest error at install time rather than a silent
puzzle-piece fallback. (It was the latter until a `TrashIcon` panel drew a puzzle piece: the schema
checked only that the name was `*Icon`-shaped.) Adding an icon means adding its name to
`PANEL_ICON_NAMES`, importing the component in `src/components/Common/ExtensionIcon/index.tsx` — the
map is typed `Record<PanelIconName, …>`, so forgetting is a compile error — and mirroring the name
into `ExtensionPanelIcon` in the SDK package, which `conformance/hostContract.ts` enforces.

**One map, every surface.** The allowlist lives in `src/components/Common/ExtensionIcon`, not in the
sidebar. It was in the sidebar, and the two settings pages hardcoded `PuzzlePieceIcon` instead — so a
`TrashIcon` extension had two identities: a trashcan in the sidebar and a puzzle piece on its own
settings page. `ExtensionHealth.icon` (`GET /settings/extensions`) carries the icon for those pages.
It is *not* a manifest field of its own: it is read off `provides.panels[].sidebar.icon`, taking the
lowest `order` so a multi-panel extension shows the icon of the panel the sidebar lists first, and it
is absent when no panel declares one — the only case where a puzzle piece is the truth.

**Two identifier patterns, not one.** An earlier draft of this spec specified a single slug pattern
for `id` and for local keys, which its own examples then violated (`view_own` contains an
underscore). As implemented in `server/lib/extensions/manifest.ts`:

- `EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]*$/` — no underscores. `id` is interpolated into table
  names, route paths, and permission strings, so it stays maximally conservative.
- `EXTENSION_KEY_PATTERN = /^[a-z][a-z0-9_-]*$/` — permission/notification/panel/job keys, which
  are namespaced behind an already-validated `id` and so can afford underscores.

### Declared admin settings

`provides.settings` is a typed schema the **host** renders a form for, at
`/settings/extensions/<id>`; the extension never ships UI for its own configuration. Field types are
`boolean | string | number | select | secret`. The zod schema enforces the cross-field rules a type
cannot: `options` is required for and only valid for a `select`, `min`/`max` only for a `number`, a
`default` must typecheck against `type` and be one of the `options`, and a `secret` **must not**
declare a `default` — that would ship a credential in the manifest, identical on every install.

Values live in `settings.json` under `settings.extensions[<id>].values`, beside `enabled`, not in
`ext_kv`: `requires.store` is optional, so an extension may declare settings and never ask for
storage, and these values are the *operator's* configuration rather than the extension's data. See
the module comment in `server/lib/extensions/settingValues.ts`. Uninstall drops them, following
`enabled` rather than the permission rows.

A `secret` is write-only from the browser's point of view: reads report a fixed sentinel, and
submitting the sentinel (or an empty string) back means **leave unchanged** — otherwise every save of
the form would overwrite the credential with asterisks. Clearing one is a separate, explicit action.
The extension reads its secrets in full through `sdk.settings.own`; redaction protects them from the
client, not from trusted in-process code.

## SDK surface

Published as `@seerr/extension-sdk`: types, the `defineExtension` helper, a build preset (externals
+ ESM output for panels), and no runtime coupling to Seerr internals.

```ts
interface ExtensionSdk {
  id: string;
  logger: Logger;                       // child of server/logger, label: `Extension:<id>`
  store: {
    dataSource: DataSource;             // main DS; entities registered under ext_<id>_*
    getRepository<T>(e: EntityTarget<T>): Repository<T>;
    kv: { get, set, delete, list };     // convenience over ext_<id>_kv, for small state
  };
  users: {                              // gated by requires.users
    get(id: number): Promise<User | null>;
    hasPermission(userId, perm: string | Permission): Promise<boolean>;
  };
  media: {                              // gated by requires.media
    get, findByTmdbId, findByRatingKey, getDetails,           // 'read'
    remove(mediaId: number, is4k?: boolean): Promise<void>;  // 'write' only
  };
  requests: { list, get };              // gated by requires.requests
  discover: {                           // gated by requires.discover ('read' only)
    trending, recommendations, similar; // all resolve ExtensionMediaDetails[]
  };
  tautulli?: {                          // requires.tautulli AND operator configured Tautulli
    reachable, userTotals, userHistory; // read-only; the operator's apiKey never crosses
  };
  settings: {                           // attached for requires.settings OR provides.settings
    main?: Readonly<MainSettings>;      // requires.settings only; core secrets redacted
    tautulli?: Readonly<…>;             // requires.settings only; apiKey omitted, not blanked
    own: Readonly<Record<string, boolean | string | number>>;  // this extension's declared values
  };
  notify: { send(key: string, payload: ExtensionNotificationPayload): Promise<void> };
  router: {                             // mounted at /api/v1/ext/<id>
    get/post/put/delete(path, opts: {
      permission?: string;              // extension or core permission
      body?: ZodSchema;                 // compensates for constraint 3
    }, handler): void;
  };
  jobs: { register(id: string, fn: () => Promise<void>): void };
  events: { on<E extends ExtensionEvent>(event: E, fn: (p: ExtensionEventMap[E]) => …): void };
}
```

**Capability-gated members are optional** (`store?`, `users?`, `media?`, …) in the implemented
`server/lib/extensions/types.ts`, because that is what the loader actually hands over — an
extension receives only what its manifest `requires` declared. Typing them as always-present would
turn a forgotten manifest declaration into a runtime `TypeError` instead of a compile error.

As shipped, `defineExtension` goes one step further: given a literal manifest it **removes**
undeclared members from the type rather than leaving them optional, so a forgotten `requires` is a
compile error instead of a `sdk.users?.get()` that silently never runs. This only works on a literal
— `const m: ExtensionManifest = {…}` erases the literal types — so authors must inline the manifest,
use `satisfies`, or import the JSON. It does not infer permission keys, job ids or notification keys
as literal unions; those stay runtime-enforced by the host.

**The access level was documentation, not enforcement.** `requires.users`, `requires.media` and
`requires.requests` have accepted `'read' | 'write'` since slice 1, but `buildSdk` gated on whether
the key was *present* — `...(requires.media ? { media: buildMedia() } : {})` — so `'read'` and
`'write'` produced an identical object. Nothing was over-granted while every member was a lookup,
but the field was making a promise the loader did not keep.

`sdk.media.remove` is the first write member, and it is gated on the level: `buildMedia` takes a
`canWrite` flag and attaches `remove` only for `'write'`, so a read-only extension's `sdk.media` has
no `remove` key at all (`'remove' in sdk.media` is false — feature-detectable, not
present-and-undefined). `defineExtension` mirrors this in the type: `'read'` resolves to
`ExtensionMedia`, `'write'` to `ExtensionMediaWrite`, and `packages/extension-sdk/conformance/hostContract.ts`
pins the agreement.

### `sdk.discover`: TMDB without a second API key

`sdk.media` answers "what does core know about this media row". It cannot answer "what else is
there" — trending titles, recommendations, similar titles — because every member of it is keyed on a
row in core's `media` table, and the interesting suggestions are for titles core has never heard of.
`sdk.discover` is that surface, gated by `requires.discover: 'read'`.

**Why it is core's job and not the extension's.** An extension could `axios` TMDB directly with its
own key. Core's `TheMovieDb` client shares one `nodeCache` and one rate limiter (20 requests, 50 RPS)
across the whole process; a second key inside an extension shares neither, so the operator's TMDB
budget is spent twice and the limiter stops protecting them. That is bad in any extension and worse
in an *example*, which is read as the pattern to copy.

`'read'` is the only level the schema accepts, like `settings` — there is nothing in TMDB an
extension writes, so a `'write'` level would name a capability that cannot exist.

Every member resolves `ExtensionMediaDetails[]`, the same shape `sdk.media.getDetails` returns, with
poster and backdrop URLs already resolved against the operator's `cacheImages` setting. Two
consequences worth stating:

- **`mediaType` is stamped from the argument, not read from the payload.** Only the multi-type
  endpoints (`/trending/all`) set TMDB's `media_type`; `/movie/:id/similar` answers one type and
  omits it. Trusting the payload would leave every recommendation with an undefined type.
- **Failure resolves `[]`, not a rejection** — the contract `getDetails` set with `null`. A caller is
  decorating a response it could serve without this, so a TMDB outage must not become a broken
  extension route. `person` and `collection` trending results are dropped for the same reason they
  cannot be mapped: neither is a title, and neither has the fields the shape promises.

**`sdk.settings.tautulli` is there for the same reason `sdk.discover` is.** Core already knows where
Tautulli lives. An extension reading watch history from it could declare its own hostname/port/key
settings, and then the operator maintains two copies that drift the moment one changes. So core's
connection travels with `requires.settings`, alongside `main`, and is gated and reviewed the same
way — `provides.settings` alone gets `own` and nothing of core's.

`apiKey` is **omitted rather than blanked**, unlike `main.apiKey`: `'apiKey' in sdk.settings.tautulli`
is false, so an extension feature-detects the absence instead of discovering it by calling Tautulli
with an empty key. An unconfigured Tautulli is `undefined` rather than `{}`, because every field is
optional and an extension could not otherwise tell "not configured" from "configured with nothing".

### `sdk.tautulli`: watch history without the operator's key

`sdk.settings.tautulli` tells an extension *where* Tautulli is; it deliberately cannot call it, because
`apiKey` is omitted. `sdk.tautulli`, gated by `requires.tautulli: 'read'`, is how an extension actually
reads watch history — and the split is the point.

**Why not just hand over the key.** Tautulli's API is one endpoint with a `cmd` parameter, and the
commands include `delete_history`, `delete_library` and `restart`. An extension holding the key can
issue any of them, and no manifest could describe that narrowly enough to review: `requires.settings`
would be a request for full control of the operator's Tautulli under a name that sounds like
configuration. So the key stays in core and the capability is three read-only methods — `reachable`,
`userTotals`, `userHistory` — which is exactly what a watch-stats extension needs and no more.

Three properties of the surface, each because of a mismatch it exists to absorb:

- **Milliseconds, not Tautulli's seconds.** Tracearr — the other watch-history source an extension
  might read — reports milliseconds. A surface that passed through whichever unit the upstream used
  would guarantee some caller multiplies in the wrong direction, so the conversion happens here once.
- **Rating keys are strings, and an episode carries its series' key.** `Media.ratingKey` is a varchar
  and `findByRatingKey` compares strings, so Tautulli's numeric keys are stringified or every lookup
  misses. Tautulli reports episodes individually; `seriesRatingKey` (its `grandparent_rating_key`) is
  what lets an extension aggregate plays per *title*, which is how core's `media` table is keyed.
- **The history cap is the host's.** `userHistory` will not return more than 100 records however it is
  asked, so an extension cannot put an unbounded Tautulli crawl on a cron.

**It is the one capability a declaration does not guarantee.** `requires.tautulli` says the extension
may read Tautulli; whether `sdk.tautulli` is *present* also depends on the operator having configured
a server. So it stays optional in `NarrowedExtensionSdk` — `defineExtension` deliberately leaves it out
of `GatedMember` — and an author has to handle the absence. That is correct: "no watch-history source
configured yet" is the normal state of a fresh install and something the extension must render, not a
manifest error. Failures resolve `false`/`null`/`[]` rather than rejecting, matching `sdk.discover`.

`users` and `requests` still grant identically for both levels. That is now correct rather than
merely harmless — neither has a write member — but the first one either gains must gate on the level
the same way rather than attaching unconditionally. There is a comment in `buildSdk` saying so.

**An extension is a backend that may have a frontend, so metadata is resolved server-side.**
`sdk.media.get` returns core's `Media` row: ids and statuses, the things an extension reasons about,
and nothing a person would recognize. An extension that lists media therefore had no way to *name*
it, and the first attempt at fixing that put the capability on the browser panel SDK — a `coreApi`
axios instance plus an `imageUrl` helper, so a panel fetched `/api/v1/movie/:tmdbId` itself.

That was the wrong layer, and it was rejected. Three things go wrong: an extension with **no UI** —
one that emails a weekly digest — gets nothing; every panel carries its own copy of the TMDB path
conventions, the size strings and the `cacheImages` proxy rule; and the extension's own routes cannot
decorate the responses they serve, so the panel becomes responsible for assembling core's data.

`sdk.media.getDetails(mediaId)` is the replacement, on the **server** SDK and granted by
`media: 'read'`. It returns `ExtensionMediaDetails`: `tmdbId`, `mediaType`, `title`, `year`,
`overview`, `posterUrl`, `backdropUrl`. Three properties are deliberate:

- **A flattened shape, not core's `MovieDetails`/`TvDetails`.** Those are large, they differ between
  media types (`title`/`releaseDate` versus `name`/`firstAirDate`), and they are shaped by what
  core's own pages happen to want — so exposing them would make every field core adds or renames a
  breaking change for every extension. One name per concept means a caller renders both media types
  with one code path.
- **Finished URLs, not paths.** `posterUrl` already honours the operator's `settings.main.cacheImages`
  — `/imageproxy/tmdb/t/p/<size><path>` when it is on, the `image.tmdb.org` URL when it is off. The
  proxy is a host route mounted outside `/api/v1` and above the OpenAPI validator, so a browser can
  use the value as a `src` unchanged. `null` when TMDB has no artwork.
- **`null` on failure, never a rejection.** A missing media row and an unreachable TMDB both resolve
  `null`. A caller is typically decorating a response it could serve without the metadata, so
  propagating would turn a metadata outage into a broken extension route. Treat it as "no metadata",
  not "no media".

**Destructive operations stay in core.** `sdk.media.remove` is a *request* for the host to perform
its own removal, not a repository the extension drives: the Radarr/Sonarr resolution, the season
fan-out and the status bookkeeping live in `server/lib/mediaRemoval.ts`, shared verbatim with
`DELETE /api/v1/media/:id/file`. An extension never constructs a `RadarrAPI`, and never gets a
repository for core's `Media`. This is what makes a write capability reviewable: the audit surface is
one host function, and the only question about an extension is whether it should be allowed to ask.

The member owns its save, unlike the helper, which mutates without persisting so that the route can
fold the removal into one write. An extension has no `Media` repository, so a member that only
mutated would hand it an unsaveable object. `NoServarrServerError` propagates unwrapped: an extension
has to tell "the operator has no Radarr configured" from "the Radarr call failed", because only the
second is worth retrying.

**`req.user` needed adding to the contract.** The host reads it off a global `Express.Request`
augmentation in `server/types/express.d.ts`, which is ambient host source a published package cannot
ship — a `declare global` in the SDK's `.d.ts` would add `user` to every Express `Request` in the
consuming project. It is therefore declared directly on `ExtensionRouteRequest` in both the SDK and
the host contract. This spec never said how a route handler is meant to identify its caller.

**Entity types are re-declared, not re-exported.** Seerr is unpublished, so there is nothing to
peer-depend on, and shipping generated `.d.ts` for `Media`/`User`/`MediaRequest` would drag in the
whole entity graph (TypeORM decorators, every relation) for types an extension only reads fields off.
The SDK declares structural stand-ins that are deliberately *width supertypes* of the real classes,
so host instances satisfy them. `packages/extension-sdk/conformance/hostContract.ts` compiles those
against the real `server/lib/extensions/types.ts` and asserts equivalence where no entity is
involved, plus matching key sets, optionality and event names — so drift fails a typecheck. The
README's example is compiled too, so the documentation cannot rot. The real type dependencies
(`express`, `typeorm`, `winston`, `zod`) are **peer** dependencies: at runtime the extension shares
the host's copies, and a second installed TypeORM would give a nominally different `Repository`.

`events` is what makes Watch History possible without polling, and is worth getting right: it
should be backed by the existing TypeORM subscribers (`server/subscriber/*`) re-emitting onto an
internal bus, so extensions observe the same transitions core does. The event list is resolved
concretely as `ExtensionEventMap` in `types.ts`, derived from transitions those subscribers already
detect — e.g. `MediaSubscriber.afterUpdate` (`server/subscriber/MediaSubscriber.ts:180`) already
identifies the `AVAILABLE` transition at `:132`/`:151`, so `media.available` needs no new detection
logic.

## Work breakdown

Dependency order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9.

**Status as of 2026-08-05. All ten slices are merged to `develop`; the system is complete.** Slice
10 (the publishable SDK package and the npm/git installer) was split out of slices 1 and 8 once it
was clear the package needed its own workspace member and a conformance harness.

| Slice | State | Landed in |
| --- | --- | --- |
| 1. Manifest + SDK types | done | PR #10 |
| 2. Storage + migration runner | done | PR #10 |
| 3. Loader + registry | done | PR #10 |
| 4. Permissions | done | PR #10 |
| 5. Route mounting | done | PR #10 |
| 6. Panel loading + sidebar | done. The residual risk it carried — a panel had never rendered in a browser against the real `_app` tree — is **closed by slice 9's `cypress/e2e/extensions/panel.cy.ts`**, which mounts Watch History's panel in Chromium and asserts its hooks ran | PR #15 |
| 7. Notifications | done | PR #12 |
| 8. Admin UI (client) | done — settings page, extension permissions in the user editor, and an extension notifications tab. The stale client `ALL_NOTIFICATIONS` is fixed by deleting the duplicate enum rather than syncing it | PR #17 |
| 9. Reference extension (Watch History) | done — `examples/watch-history`, driven through the real loader by `server/lib/extensions/watchHistory.test.ts`. Found three SDK-adequacy problems, two fixed and one documented; see below. Also carries the browser panel test that closes slice 6's residual risk | PR #18 |
| 10. SDK package + installer | done | PR #11 |

Test count on `develop` after slice 9: **681**.

### What slice 9 found

The slice was specced expecting "slices 1–8 to need revision here", and it did. Three problems,
all of which were invisible before an extension was written the way the docs said to write one:

1. **The documented way to supply a manifest defeated the whole point of `defineExtension`.** The
   SDK README said `import manifest from '../seerr-extension.json'`. `resolveJsonModule` widens as
   it infers — a JSON `true` becomes `boolean` — so every conditional in `DeclaredCapability` fails
   to match and *no* capability is narrowed. Silently: nothing errors, `sdk.store` is just
   `ExtensionStore | undefined` again. Fixed in the README and the compiled conformance example,
   which now use `as const satisfies`. The cost is that a manifest exists twice, so the reference
   extension carries a test asserting the built literal is deep-equal to the JSON on disk.
2. **An extension cannot portably declare a date column.** Core writes dates through
   `DbAwareColumn`, which rewrites `datetime` to `timestamp with time zone` on Postgres by reading
   `isPgsql` off the live DataSource. An extension has neither — the helper is host-internal, and
   entity classes are loaded at *discovery*, before the DataSource exists, so there is nothing to
   ask about the dialect at decoration time. A bare `type: 'datetime'` therefore works on sqlite
   and fails on Postgres, which is a bug that only appears on someone else's deployment. Worked
   around in the extension (`bigint` epoch millis plus a transformer) and documented; exposing a
   dialect-aware column helper through the SDK is the real fix and is not done.
3. **`injectExtensionEntities` only appends to the DataSource's *options*.** TypeORM builds entity
   metadata during `initialize()` and does not rebuild it afterwards, so injecting into an
   already-initialized DataSource silently yields `No metadata for "…" was found` on the first
   repository call. Production is unaffected — boot injects before initializing — but this is worth
   stating: the function's name suggests it works whenever it is called, and it does not.

Slice 8 edits `src/`, which slice 6 also did; with 6 merged there is no longer a conflict to avoid.

1. **Manifest + SDK types.** `seerr-extension.json` zod schema, `ExtensionSdk` interfaces, the
   `@seerr/extension-sdk` package skeleton. No runtime behavior. Unit-test the schema against both
   reference manifests and a deliberately malformed one.

2. **Storage + migration runner.** `ext_permission`, `ext_notification_subscription`,
   `ext_<id>_kv` core tables (migration per dialect, **different timestamps**, matching
   `1785864935643-AddMediaRemovalRequest.ts` / `1785865019657-...`). Per-extension migration
   DataSource with `migrationsTableName`. Table-prefix enforcement.

3. **Loader + registry.** Discover from `config/extensions/`, validate manifest, `semver`-check
   `apiVersion`, build the gated SDK, `require` the entry, catch and quarantine failures. Health
   state exposed for the admin UI. Called from `server/index.ts` after settings load.

4. **Permissions.** Namespaced storage, resolution rules (ADMIN short-circuit, `requiresCore`,
   `default`), server-side `sdk.users.hasPermission`, and an `isAuthenticated`-equivalent
   middleware for extension routes. Extend `GET /api/v1/user/:id` (or add a sibling) so the client
   can see granted extension permissions.

5. **Route mounting.** Extension router mounted in `server/index.ts` **before** the OpenAPI
   validator, with a comment citing constraint 3. Per-route zod validation, permission gating,
   and a 404 for unknown/disabled extensions. Verify a core route still validates as before.

6. **Panel loading.** `src/pages/extensions/[...slug].tsx`, bundle-serving route with correct
   MIME/caching, shared-React mechanism, client SDK, error boundary per panel, sidebar injection
   in `src/components/Layout/Sidebar/index.tsx` (its `SidebarLinks` array and `menuMessages` are
   both static — extension entries need a parallel path that does not go through
   `menuMessages[messagesKey]`, since extension titles are not extractable by
   `server/i18n/extractMessages.ts`).

7. **Notifications.** `Notification.EXTENSION` sentinel, `extensionEvent` on `NotificationPayload`,
   subscription storage + per-user UI section, `sdk.notify.send`, and the per-agent display
   fallbacks (`webpush.ts`'s `default:` branch especially). Confirm `sw.js` tolerates an unknown
   `notificationType`.

8. **Admin UI + install.** Settings page listing extensions with health/enable/disable, install
   from npm or git URL, uninstall. Out-of-process install, never touching Seerr's `node_modules`.

   **Uninstall retention.** An earlier draft of this section said uninstall drops "its rows in the
   core extension tables" wholesale, which contradicts the decision in "Permissions" above that an
   uninstalled extension's rows are inert rather than deleted. What ships, and what the tests pin:

   - **Always dropped:** `ext_<id>_*` tables (found by prefix scan, so a table orphaned by a removed
     entity is still caught) including `ext_<id>_migration`, and `ext_kv` rows for the id. Their
     shape was defined by entity classes that leave with the directory, so a later reinstall would
     otherwise meet a wrongly-shaped table whose migration history claims it is current.
   - **Retained by default:** `ext_permission` and `ext_notification_subscription` rows. Those record
     the *operator's* decisions about users, not the extension's data; they are string-keyed
     precisely so they can outlive the code, and quarantine already keeps them so that restoring an
     extension restores its grants. `purgeData: true` is the explicit opt-in to forget them.
   - **Always forgotten:** the enable/disable setting, since it described the install just removed —
     reinstalling something that had been disabled brings it back enabled.

   The directory is removed **last**, so a database failure leaves a retryable install rather than a
   half-removed one.

   **Install and enable/disable require a restart.** Discovery must register entities before
   `dataSource.initialize()`, so nothing can take effect mid-process. Every mutating response returns
   `restartRequired: true`, and `GET` reports on-disk-but-unloaded extensions as `pending` so a fresh
   install does not look like a no-op.

   **Fetching is restricted on both paths, not one.** `sourceKind` sends only recognizable git
   remotes to git; everything else goes to npm. So refusing `file://` and `ext::` in the git command
   alone does nothing — npm accepts `file:` specifiers, bare paths and `github:`-style shorthands as
   package sources. The npm side allowlists the registry name shape plus a local `.tgz`; the git side
   allowlists http(s)/ssh/git and scp-style remotes. Consequence: the git path has no end-to-end
   test, because a local test remote would need `file://`. None of this is a privilege boundary —
   installing is an ADMIN action and extensions are trusted, `require()`d in-process — it keeps a
   documented restriction honest.

9. **Reference extension.** Watch History, in its own repo-shaped directory, exercising the full
   surface (permissions, panel, notifications, store, jobs, events). This is the real test of whether
   the SDK is adequate — expect slices 1–8 to need revision here.

   Shipped as `examples/watch-history`, deliberately outside every tsconfig this repo compiles:
   an extension is built separately, installed into `config/extensions/<id>/`, and `require()`d from
   disk, so a reference extension inside the host's own build would prove nothing about that path.
   `server/lib/extensions/watchHistory.test.ts` therefore compiles it with its own `tsc`, copies the
   result into a scratch extensions directory with the SDK symlinked into its `node_modules`, and
   drives it through `discoverExtensions`/`activateExtensions` — then calls its route handlers, emits
   `request.available` at it, and runs its job. It covers the migration path separately from the
   `synchronize: true` path, since only the former is what a production install takes.

   It also carries `cypress/e2e/extensions/panel.cy.ts`, which is the part no server test can do:
   mount the panel in a browser against the real `_app` tree. That closes the risk slice 6 left open;
   see the open-questions list. Running it is a manual sequence (build, copy, migrate, enable,
   boot) documented in the spec's own header, because an extension only takes effect at boot.

   Three SDK-adequacy problems this found are recorded under "What slice 9 found" above. The one
   still open is the dialect-portable column: an extension has no access to `DbAwareColumn` and no
   DataSource to ask at decoration time, so it cannot declare a `datetime` that works on both
   backends. Watch History works around it with `bigint` epoch millis; the fix is an SDK-exposed
   column helper, which is not done.

   Originally specced as *two* reference extensions, Unrequest and Watch History. Unrequest is
   dropped: it duplicated the media-removal feature on `feat/media-removal-requests` (PR #9), which is
   deliberately **separate work and not a dependency of this system**. Nothing in the extension system
   builds on it, and the three `removal-request.*` events an early draft of `ExtensionEventMap`
   carried were removed for that reason. Watch History alone covers the same SDK surface.

   `media: 'write'` and `sdk.media.remove` make an Unrequest-style extension *possible* without
   making the system depend on PR #9: the capability was added on its own, against its own tests, and
   the removal logic it exposes was extracted from core's existing `DELETE /api/v1/media/:id/file`
   rather than taken from that branch. No removal-request extension is implemented here.

## Migration safety

Because extension tables live in the core database, the runner must enforce:

- Every table an extension creates is prefixed `ext_<id>_`. Reject a migration that creates or
  alters anything else. (Best-effort — SQL-string inspection, not a sandbox. Documented as such.)
  Comma-separated `DROP TABLE`/`TRUNCATE` lists are checked name by name, and the objects TypeORM's
  Postgres driver derives from a table it owns — `CREATE/DROP/ALTER TYPE` for enums,
  `CREATE/DROP/ALTER SEQUENCE`, `COMMENT ON TABLE`/`COLUMN` — are attributed to that table by its
  prefix, because refusing them would quarantine an extension on Postgres that passed on sqlite.
  Still unattributable and so refused outright: views, triggers, functions, grants, `DROP SCHEMA`.
- An extension id may not claim a core table through its prefix. Core keeps `ext_permission`,
  `ext_kv` and `ext_notification_subscription` in the same namespace, so the id `notification` would
  own `ext_notification_subscription`. Rejected at manifest validation, and the uninstall table scan
  skips core-owned names regardless.
- Extension migrations run in their own `ext_<id>_migration` tracking table, never core's.
- Extension migration failure quarantines that extension; Seerr still boots.
- sqlite runs `PRAGMA foreign_keys=OFF` around core migrations (`server/index.ts:76-78`) — extension
  migrations need the same treatment for table rewrites.

## Open questions

- ~~**Shared-React mechanism** (slice 6)~~ — **ANSWERED by spike; see "Panels" above.** Import map
  *plus* host-provided global, composed. Verified in a real browser: hooks work, panel/host React
  bindings are `===`, context crosses the boundary both ways, and a deliberately-doubled React fails
  with the null-dispatcher error. Remaining risk is recorded below rather than here.
- **Panel gating needs a self-service permissions endpoint** (slice 6). The client's `hasPermission`
  is synchronous and bitmask-only, but extension permissions are async DB rows. Slice 4's
  `GET /user/:id/settings/extension-permissions` is `MANAGE_USERS`-gated and keyed by *another*
  user's id, so there is no way for a signed-in user to learn their **own** effective extension
  permissions. Slice 6 added one: `GET /api/v1/extensions/permissions`, self-service and
  `isAuthenticated()`-only, alongside `GET /api/v1/extensions/panels`. Slice 4's endpoint stays as
  it was — `MANAGE_USERS`-gated and keyed by another user's id.
- ~~**Residual slice-6 risk: panels never rendered in the real `_app` tree.**~~ **CLOSED in slice 9.**
  `cypress/e2e/extensions/panel.cy.ts` boots the built server with Watch History installed from
  `config/extensions/`, clicks its sidebar link, and asserts the panel's mount-time `sdk.api` fetch
  fired — which only happens if `useEffect` ran, i.e. if the import map handed the panel the *host's*
  React and the `sdk` prop arrived intact. It also asserts the console carries no invalid-hook-call
  or duplicate-React warning, and that the served bundle still contains bare `from "react"` rather
  than an inlined copy. Verified passing 4/4 against `next start` in Chromium. The spec skips itself
  when no `watch-history` panel is reported, so a green suite on a checkout with no extensions
  installed does **not** mean it ran — its header documents the exact install sequence, including the
  two steps that fail confusingly (`WITH_MIGRATIONS=true`, and enabling the extension *after*
  `cypress:prepare` overwrites `settings.json`).
- **Remaining slice-6 risks, narrower than the above.** The design hinges on `_app.tsx` publishing the global at module
  scope before any panel `import()`; the shims throw a clear diagnostic if that ordering is ever
  violated, which is worth keeping. Import-map ordering was verified only under `next start`, not
  `next dev` or with `basePath`/`assetPrefix` set, and only in Chromium. Seerr ships no CSP today; if
  one is added, the inline `<script type="importmap">` needs a nonce. Finally, React version coupling
  is silent — a panel built against React 18 gets 19 with no error, so a manifest `requires.react`
  check is worth considering.
- ~~**Panels-only extensions register nothing today.**~~ Fixed: `createExtensionRouter` mounts a
  sub-router when an extension has routes *or* panels, so a panel-only extension still gets its
  bundles served (`server/routes/extension.ts`).
- **`PermissionItem.permission` widening** — extension permissions are strings, core's are numbers.
  A discriminated union is cleanest but touches `PermissionOption`'s logic (`index.tsx:39-66`),
  which does arithmetic on `permission`.
- **i18n for extension-supplied strings.** Extensions ship their own message catalogs; the host
  `IntlProvider` is configured in `_app.tsx` from static imports. Simplest v1: extensions receive
  an `intl` scoped to their own catalog, merged at panel-mount time rather than into core's.
- **`http` allowlist enforcement.** Advisory in v1 (documented, unenforced) since extensions can
  `require('axios')` directly. Real enforcement needs process isolation.

## Verification

```
pnpm lint
pnpm typecheck
pnpm test
pnpm migration:run   # scratch copy of BOTH sqlite and postgres
```

Manual, per slice, and specifically:

- Boot with zero extensions installed — no behavior change, no new tables queried at runtime.
- Boot with a deliberately broken extension (bad manifest, throwing entry, failing migration) —
  Seerr starts, extension shows unhealthy.
- Install Watch History, grant a non-admin `view_own`, confirm the sidebar link appears for them
  and its panel loads; confirm `view_all` is hidden without `MANAGE_USERS`.
- Confirm a core API route still returns 400 on a schema-invalid body (validator still active
  after the mount-order change).
- Uninstall an extension, confirm `ext_<id>_*` tables and its `ext_kv` rows are gone, that its
  `ext_permission` and `ext_notification_subscription` rows are **retained** (see below), and that
  `purgeData: true` removes those too. Then confirm every user's core notification prefs are
  byte-identical to before install.
