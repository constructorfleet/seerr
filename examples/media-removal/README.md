# Media Removal Requests — a Seerr extension

Lets a user ask for media they requested to be deleted again — an "unrequest".
The request behaves like an ordinary media request: pending, approved, declined or
auto-approved, notifying at each transition. Approving it deletes the media from
Radarr/Sonarr, files included, and flags core's `media` row `DELETED`.

## Why this is an extension

It was drafted as a core feature. That version needed a new entity with relations
into `Media` and `User`, a new `Permission` bit, a new `MainSettings` field with
four client-side touch points, three new `Notification` bits, and a new `case` in
each of nine notification agents — a diff across a dozen files core already has
for other reasons, for a feature many installs will never enable.

As an extension it is this directory, and core keeps exactly one thing: the
removal itself, behind `sdk.media.remove`. **The extension never constructs a
RadarrAPI and never gets a repository for core's `Media`.** It asks the host to
run its own removal — the same `removeMediaFromServarr` path
`DELETE /api/v1/media/:id/file` runs — which is what makes a destructive
capability reviewable: the audit surface is one host function.

| Capability | Where it is used |
| --- | --- |
| `store` (entity) | `src/entity/RemovalRequest.ts`, one `ext_media-removal_request` table |
| `users: read` | `hasPermission` for `manage`, and resolving the requester to notify |
| **`media: write`** | `sdk.media.remove` — the only `'write'` in `examples/` |
| `requests: read` | "did you request this yourself?", and the panel's picker |
| `settings: read` | `applicationTitle` in notifications |
| declared settings | `auto_approve_unavailable`, read via `sdk.settings.own` |
| routes | `POST`/`GET /requests`, `GET /requests/:id`, `POST /requests/:id/:status`, `DELETE /requests/:id`, `GET /removable` |
| permissions | `request` (`requiresCore: REQUEST`) and `manage` (`requiresCore: MANAGE_REQUESTS`) |
| notifications | `pending`, `approved`, `declined`, `auto_approved`, `failed` |
| panel | `dist/panel.js`, sidebar `TrashIcon` — the whole user-facing UI; see below |

## Routes

Mounted at `/api/v1/ext/media-removal`.

| Route | Permission | Behaviour |
| --- | --- | --- |
| `POST /requests` | `request` | `{ mediaId, is4k? }`. 404 unknown media; 400 already `DELETED` or untracked (`UNKNOWN`) variant; 409 an open request for the same media and variant; 403 unless the caller owns a non-declined core request — **including** when the caller holds `manage`. Auto-approval is applied at insert. `201` with the row. |
| `GET /requests` | `request` | Paginated (`take` capped at 100, `skip`). Own rows only, unless the caller holds `manage`. |
| — | — | Every route serving a row adds a resolved `tmdbId` (`null` if the media is gone). The column is `mediaId`, because that is what a removal takes; `tmdbId` is what core's metadata endpoints are keyed on, so it is resolved per response rather than denormalized into a column that could go stale. |
| `GET /requests/:id` | `request` | Owner, or `manage`. |
| `POST /requests/:id/:status` | `manage` | `pending`/`approve`/`decline`. Anything else is a 400 *before* the row is read. |
| `DELETE /requests/:id` | `request` | The owner may withdraw while `PENDING`; after that it takes `manage`. |
| `GET /removable` | `request` | The caller's own non-declined core requests, one entry per variant, each flagged `available`, `removed`, `tracked` and `removalRequested`. This is what the panel's picker offers. |

## Auto-approval

One rule, evaluated **before** the insert so the row is never briefly pending and
the notification reads as automatic: **the operator opted in *and* nothing is
available yet** — the variant's status is neither `AVAILABLE` nor
`PARTIALLY_AVAILABLE`. The deletion destroys nothing a user would miss. Available
media always needs review, whatever the setting says.

The switch is `auto_approve_unavailable`, a `boolean` declared under
`provides.settings` in the manifest and edited by an operator at
**Settings → Extensions → Media Removal Requests**, behind core's `ADMIN` gate.
It is deliberately not something this extension can write: it decides whether a
destructive action skips review, so it belongs to the operator, not to the
extension or to a `manage` holder. `sdk.settings.own` is read-only.

Holding `manage` is *not* a second auto-approval rule. An earlier draft let an
approver's own request skip review as ceremony-avoidance, which left a hole in the
queue that is meant to record what was deleted and who decided it — an admin's own
removals never appeared there. The ownership check applies to approvers too: one
extra click buys a review log with nothing missing from it.

An approved removal that Radarr/Sonarr refuses becomes `FAILED`, not `APPROVED`,
and is retryable. Core saves the `media` row only after the arr call returns, so a
failure never leaves it half-removed.

## The panel

`src/panel.tsx` is the entire user interface: one screen for both audiences,
gated on `request` so a requester reaches it, with the routes doing the
narrowing. A user without the `request` permission never sees the sidebar link at
all; a user with it opens the panel and sees only their own requests; an approver
opens the same panel and sees the pending queue. It lists requests with paging,
opens new ones, approves, declines and withdraws. It hosts **no** operator
control — the auto-approval switch is an admin setting, above.

Three things about it are decisions rather than mechanics:

- **Approving is confirmed in the row, and its result is read off the response.**
  Approval performs the removal synchronously, so the response carries the
  *settled* status — COMPLETED or FAILED, never a bare APPROVED. The panel
  therefore reports what actually happened instead of optimistically saying
  "approved", and a FAILED row renders as retryable, because approving it again
  is exactly the retry. The confirm step is inline rather than a `window.confirm`
  so that the sentence naming which files get deleted, and from which arr, is on
  screen when the decision is made.
- **The server's messages are shown verbatim.** Every 400/403/404/409 these
  routes issue is written for a person and names a state the panel could not have
  ruled out before asking. A generic "something went wrong" would throw away the
  only useful half of the response.
- **It looks like the Requests page, and that took `sdk.coreApi`.** Rows are
  posters, titles and years in the `RequestList` card layout, because a removal
  request *is* a request and listing the same media by numeric id next to a page
  that lists it by poster is an unfinished design, not a different one. The
  metadata is not in the server SDK: `sdk.media.get` returns core `Media` rows,
  ids and statuses, and deliberately not TMDB details — an extension that wants a
  poster wants it in a browser, and proxying tmdb.org through a server capability
  would make core fetch and cache on an extension's behalf for a purely
  presentational read. So the panel reads core's own API as the signed-in user
  through `sdk.coreApi` (`GET movie/:tmdbId`, `GET tv/:tmdbId`, `GET user/:id`,
  each `isAuthenticated()` and no more), and images go through `sdk.imageUrl` into
  a plain `<img>`, since `CachedImage` needs the host build. Metadata is fetched
  *after* the rows render, so a page of 20 never waits on 20 TMDB reads. Note the
  boundary: core's routes are not a stable API, so this is fine for presentation
  and the extension's logic still runs against its own routes.
- **The picker enumerates, it does not ask.** Since the server only permits
  removal of media you requested, every id a user could have successfully typed
  into a freeform box was already known to the server — so `GET /removable`
  returns the set and the panel offers it as a `<select>` of titles, filtered to
  entries that are still tracked, not already removed, and have no open request,
  with the selection's poster shown beside it. An unguessable-id input was worse
  than unfriendly; it asked the user for something the server could simply list.
- **There is still no media-page button, and that is a limitation, not a choice.**
  In the core draft this was a control beside the request button on the media
  detail page. A panel cannot edit core's `RequestButton`, so removal starts from
  the panel rather than from the media you are looking at. Closing the gap needs a
  core extension point for *media-page actions*: a slot an extension can
  contribute a control to with the media in scope. That is follow-up work for the
  extension system, and it is the one limitation this conversion exposed that a
  better panel could not fix.

`swr` is a shared specifier but goes unused, for the reason `watch-history`'s
panel documents: the host publishes its own SWR *instance*, so a panel using it
inherits the app's global fetcher rather than the extension-scoped `sdk.api`.
`axios` is imported for its `AxiosInstance` type only — a type-only import emits
nothing, so the unmapped specifier never reaches the browser. `react-intl` *is*
imported as a value, for `FormattedRelativeTime`, which is what makes "29 seconds
ago" read the same here as on the Requests page.

## Four things worth reading the comments for

Each is explained where it happens rather than here, and each is a place the
core design could not be carried across:

1. **Notification keys are the extension's own, not core `Notification` bits.**
   The core draft claimed bits 8192, 16384 and 32768. 8192 is now
   `Notification.EXTENSION`, the sentinel every extension notification is
   persisted under, so an extension referencing a bit at all would be renumbering
   core's enum from outside. See `src/manifest.ts`.
2. **The auto-approval setting is a *declared* setting, not kv and not
   `MainSettings`.** Core's settings object is not extensible from outside, and a
   writable core settings surface would be a much larger capability than this
   feature needs — but kv was wrong too, because kv is read-write to the
   extension, so the extension could rewrite the operator's own
   destructive-behaviour switch. Declaring it in the manifest puts it on
   Settings → Extensions behind `ADMIN`, and leaves the extension only
   `sdk.settings.own`, which is read-only. The cost: it is not on Settings →
   General beside core's other auto-approval options. See `SETTING_KEY` in
   `src/index.ts`.
3. **`NoServarrServerError` is recognized by its `arrName` property**, because an
   extension cannot import the class from `@server/*`. The distinction is worth
   surfacing to an operator: no configured server will never succeed on a retry,
   where a failed arr call might. See `describeFailure`.
4. **The id columns are plain integers, not relations.** A foreign key from an
   extension table into a core one makes uninstalling a schema problem for core
   rather than a `DROP TABLE`. The core version got `onDelete: 'CASCADE'` for free;
   this one tolerates rows whose media is gone. See
   `src/entity/RemovalRequest.ts`.

The status values deliberately mirror core's `MediaRequestStatus` numbering, so
`status = 2` means APPROVED in both tables and a support answer for one works for
the other. The enum itself cannot be imported.

## Building

```
pnpm build      # both halves
pnpm typecheck
```

Two tsconfigs: `tsconfig.json` emits CommonJS (the host `require()`s the entry
point, and `export =` only means something under CJS emit), and
`tsconfig.panel.json` emits ES2022 modules with bare `from "react"` specifiers,
which are what the host's import map rewrites to *its* React.

## Installing

```
pnpm build
cp -r . "${CONFIG_DIRECTORY:-config}/extensions/media-removal"
# then restart Seerr and enable it under Settings → Extensions
```

Restarting is required: TypeORM cannot register an entity after
`DataSource.initialize()`, so an extension contributing a table is only picked up
at boot.
