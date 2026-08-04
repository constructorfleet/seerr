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
`MEDIA_REMOVAL_AUTO_APPROVED = 65536` (bit 16), so bits are *not* scarce here. The problem is
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
SDK's build preset marks them external, and the host provides them to the bundle. Two viable
mechanisms; pick during implementation slice 6:

- An import map plus native `import()` — clean, but needs the externals exposed at stable URLs.
- The host passing them in on a well-known global that the SDK preset rewrites imports to
  (`window.__seerr_shared__`) — uglier, no import-map browser-support question, and works with
  the existing Next build with no config change. **Prefer this unless the import map proves easy.**

Panels receive a client SDK prop: `{ user, hasPermission, api, notify, intl }`, where `api` is an
axios instance pre-scoped to `/api/v1/ext/<id>/` so the extension cannot accidentally call core
endpoints, and inherits the app's CSRF cookie behavior (`XSRF-TOKEN`, `server/index.ts:194-200`).

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
enum member — bit 17, safe, and it keeps `ALL_NOTIFICATIONS` install-independent because it does
not vary with what is installed). Agents that already render generically need no change:
`webhook.ts` reverse-maps `Notification[type]` and reads `templateSource` (`webhook.ts:22-27`).
`webpush.ts` has a `default:` branch that silently renders `subject: 'Unknown'` — it must be
updated or extension pushes will be unlabeled.

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
    "media": "read",
    "requests": "read",
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
    ]
  }
}
```

`sidebar.icon` is a name from `@heroicons/react/24/outline`, resolved against an explicit allowlist
map — not a dynamic import of an arbitrary string.

**Two identifier patterns, not one.** An earlier draft of this spec specified a single slug pattern
for `id` and for local keys, which its own examples then violated (`view_own` contains an
underscore). As implemented in `server/lib/extensions/manifest.ts`:

- `EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]*$/` — no underscores. `id` is interpolated into table
  names, route paths, and permission strings, so it stays maximally conservative.
- `EXTENSION_KEY_PATTERN = /^[a-z][a-z0-9_-]*$/` — permission/notification/panel/job keys, which
  are namespaced behind an already-validated `id` and so can afford underscores.

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
  media: { get, findByTmdbId };         // gated by requires.media
  requests: { list, get };              // gated by requires.requests
  settings: { main: Readonly<MainSettings> };  // secrets redacted
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

`events` is what makes Watch History possible without polling, and is worth getting right: it
should be backed by the existing TypeORM subscribers (`server/subscriber/*`) re-emitting onto an
internal bus, so extensions observe the same transitions core does. The event list is resolved
concretely as `ExtensionEventMap` in `types.ts`, derived from transitions those subscribers already
detect — e.g. `MediaSubscriber.afterUpdate` (`server/subscriber/MediaSubscriber.ts:180`) already
identifies the `AVAILABLE` transition at `:132`/`:151`, so `media.available` needs no new detection
logic.

## Work breakdown

Dependency order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9.

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
   from npm or git URL, uninstall (including dropping `ext_<id>_*` tables and its rows in the
   core extension tables). Out-of-process install, never touching Seerr's `node_modules`.

9. **Reference extensions.** Unrequest and Watch History, each in its own repo-shaped directory,
   exercising the full surface (permissions, panel, notifications, store, jobs, events). These are
   the real test of whether the SDK is adequate — expect slices 1–8 to need revision here.

## Migration safety

Because extension tables live in the core database, the runner must enforce:

- Every table an extension creates is prefixed `ext_<id>_`. Reject a migration that creates or
  alters anything else. (Best-effort — SQL-string inspection, not a sandbox. Documented as such.)
- Extension migrations run in their own `ext_<id>_migration` tracking table, never core's.
- Extension migration failure quarantines that extension; Seerr still boots.
- sqlite runs `PRAGMA foreign_keys=OFF` around core migrations (`server/index.ts:76-78`) — extension
  migrations need the same treatment for table rewrites.

## Open questions

- **Shared-React mechanism** (slice 6): import map vs. host-provided global. Narrowed since first
  draft: Seerr has **no bundler of its own** in `package.json` (no esbuild/rollup/vite/tsup — only
  Next's own toolchain), so extensions build their own panel bundles and Seerr merely *serves*
  pre-built ESM. The question therefore reduces to how a bare `import 'react'` inside that bundle
  resolves in the browser. React is 19.2.6 and ships `jsx-runtime`, which must be shared too, not
  just `react` itself. Try the import map first (broadly supported, keeps extension source
  idiomatic); fall back to the preset rewriting specifiers onto a host global.
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
- Uninstall an extension, confirm `ext_<id>_*` tables are gone and no orphaned permission rows
  remain, then confirm every user's core notification prefs are byte-identical to before install.
