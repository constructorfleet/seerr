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
| `store.kv` | the `autoApproveWhenUnavailable` setting |
| `users: read` | `hasPermission` for `manage`, and resolving the requester to notify |
| **`media: write`** | `sdk.media.remove` — the only `'write'` in `examples/` |
| `requests: read` | "did you request this yourself?" |
| `settings: read` | `applicationTitle` in notifications |
| routes | `POST`/`GET /requests`, `GET /requests/:id`, `POST /requests/:id/:status`, `DELETE /requests/:id`, `GET`/`POST /settings` |
| permissions | `request` (`requiresCore: REQUEST`) and `manage` (`requiresCore: MANAGE_REQUESTS`) |
| notifications | `pending`, `approved`, `declined`, `auto_approved`, `failed` |
| panel | `dist/panel.js`, sidebar `TrashIcon` — the whole UI; see below |

## Routes

Mounted at `/api/v1/ext/media-removal`.

| Route | Permission | Behaviour |
| --- | --- | --- |
| `POST /requests` | `request` | `{ mediaId, is4k? }`. 404 unknown media; 400 already `DELETED` or untracked (`UNKNOWN`) variant; 409 an open request for the same media and variant; 403 unless the caller owns a non-declined core request, or holds `manage`. Auto-approval is applied at insert. `201` with the row. |
| `GET /requests` | `request` | Paginated (`take` capped at 100, `skip`). Own rows only, unless the caller holds `manage`. |
| `GET /requests/:id` | `request` | Owner, or `manage`. |
| `POST /requests/:id/:status` | `manage` | `pending`/`approve`/`decline`. Anything else is a 400 *before* the row is read. |
| `DELETE /requests/:id` | `request` | The owner may withdraw while `PENDING`; after that it takes `manage`. |
| `GET`/`POST /settings` | `manage` | `{ autoApproveWhenUnavailable: boolean }`, backed by kv. |

## Auto-approval

Two rules, both evaluated **before** the insert so the row is never briefly
pending and the notification reads as automatic:

1. **The caller holds `manage`.** Making an approver approve their own request is
   ceremony. Core `Permission.ADMIN` short-circuits inside `hasPermission`, which
   `sdk.users.hasPermission` honours, so an admin lands here too.
2. **The operator opted in *and* nothing is available yet** — the variant's status
   is neither `AVAILABLE` nor `PARTIALLY_AVAILABLE`. The deletion destroys nothing
   a user would miss. Available media always needs review, whatever the setting
   says.

An approved removal that Radarr/Sonarr refuses becomes `FAILED`, not `APPROVED`,
and is retryable. Core saves the `media` row only after the arr call returns, so a
failure never leaves it half-removed.

## The panel

`src/panel.tsx` is the entire user interface: one screen for both audiences,
gated on `request` so a requester reaches it, with the routes doing the
narrowing. It lists requests with paging, opens new ones, approves, declines and
withdraws, and hosts the auto-approval switch for `manage` holders.

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
- **There is no media-page button, and that is a limitation, not a choice.** In
  the core draft this was a control beside the request button on the media detail
  page. A panel cannot edit core's `RequestButton`, so the panel offers a form
  taking a numeric media id instead — plainly worse, since nobody knows their
  media ids. Closing the gap needs a core extension point for *media-page
  actions*: a slot an extension can contribute a control to with the media in
  scope. That is follow-up work for the extension system, and it is the one
  limitation this conversion exposed that a better panel could not fix.

`swr` is a shared specifier but goes unused, for the reason `watch-history`'s
panel documents: the host publishes its own SWR *instance*, so a panel using it
inherits the app's global fetcher rather than the extension-scoped `sdk.api`.
`axios` is imported for its `AxiosInstance` type only — a type-only import emits
nothing, so the unmapped specifier never reaches the browser.

## Four things worth reading the comments for

Each is explained where it happens rather than here, and each is a place the
core design could not be carried across:

1. **Notification keys are the extension's own, not core `Notification` bits.**
   The core draft claimed bits 8192, 16384 and 32768. 8192 is now
   `Notification.EXTENSION`, the sentinel every extension notification is
   persisted under, so an extension referencing a bit at all would be renumbering
   core's enum from outside. See `src/manifest.ts`.
2. **The auto-approval setting lives in this extension's kv store, not
   `MainSettings`.** Core's settings object is not extensible from outside, and a
   writable core settings surface would be a much larger capability than this
   feature needs. The cost, named in the code: the switch does *not* appear on
   Settings → General with the other auto-approval options — only in this
   extension's panel. See `SETTING_KEY` in `src/index.ts`.
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
