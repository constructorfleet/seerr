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

As shipped, `defineExtension` goes one step further: given a literal manifest it **removes**
undeclared members from the type rather than leaving them optional, so a forgotten `requires` is a
compile error instead of a `sdk.users?.get()` that silently never runs. This only works on a literal
— `const m: ExtensionManifest = {…}` erases the literal types — so authors must inline the manifest,
use `satisfies`, or import the JSON. It does not infer permission keys, job ids or notification keys
as literal unions; those stay runtime-enforced by the host.

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

**Status as of 2026-08-04.** Slices 1–7 and 10 are merged to `develop`; 8 and 9 remain. Slice
10 (the publishable SDK package and the npm/git installer) was split out of slices 1 and 8 once it
was clear the package needed its own workspace member and a conformance harness.

| Slice | State | Landed in |
| --- | --- | --- |
| 1. Manifest + SDK types | done | PR #10 |
| 2. Storage + migration runner | done | PR #10 |
| 3. Loader + registry | done | PR #10 |
| 4. Permissions | done | PR #10 |
| 5. Route mounting | done | PR #10 |
| 6. Panel loading + sidebar | done — one residual risk, below: a panel has never rendered in a browser against the real `_app` tree | PR #15 |
| 7. Notifications | done | PR #12 |
| 8. Admin UI (client) | **remaining** — the server side landed in #11; this is the settings page, and it must also fix the client's stale `ALL_NOTIFICATIONS` (see "Notifications") | — |
| 9. Reference extension (Watch History) | **remaining** — Unrequest dropped; media removal is separate work and not a dependency | — |
| 10. SDK package + installer | done | PR #11 |

Test count on `develop` after slice 6: **664**.

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

   Originally specced as *two* reference extensions, Unrequest and Watch History. Unrequest is
   dropped: it duplicated the media-removal feature on `feat/media-removal-requests` (PR #9), which is
   deliberately **separate work and not a dependency of this system**. Nothing in the extension system
   builds on it, and the three `removal-request.*` events an early draft of `ExtensionEventMap`
   carried were removed for that reason. Watch History alone covers the same SDK surface.

## Migration safety

Because extension tables live in the core database, the runner must enforce:

- Every table an extension creates is prefixed `ext_<id>_`. Reject a migration that creates or
  alters anything else. (Best-effort — SQL-string inspection, not a sandbox. Documented as such.)
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
- **Residual slice-6 risk, still open after PR #15.** Panels have never been rendered inside Seerr's
  real `_app` tree (Layout, `SWRConfig`, `IntlProvider`) — only in a standalone harness — so that is the
  highest-value first check. The design also hinges on `_app.tsx` publishing the global at module
  scope before any panel `import()`; the shims throw a clear diagnostic if that ordering is ever
  violated, which is worth keeping. Import-map ordering was verified only under `next start`, not
  `next dev` or with `basePath`/`assetPrefix` set, and only in Chromium. Seerr ships no CSP today; if
  one is added, the inline `<script type="importmap">` needs a nonce. Finally, React version coupling
  is silent — a panel built against React 18 gets 19 with no error, so a manifest `requires.react`
  check is worth considering.
- **Panels-only extensions register nothing today.** `registry.panels()` returns only `active`
  extensions, and per-id sub-routers are created for extensions that registered *routes*, so an
  extension providing a panel and no routes gets no bundle route mounted. Register the bundle route
  independently of `routesFor()`.
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
