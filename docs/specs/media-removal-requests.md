# Media Removal Requests ("Unrequests")

## Summary

Users can request removal of media they previously requested — an "unrequest". Removal
requests behave like ordinary requests: they can be pending approval, auto-approved,
declined, and they emit notifications at each transition. When a removal request is
approved, the media is deleted from Radarr/Sonarr (including files) and the local `media`
row is flagged `MediaStatus.DELETED`.

Gated by a new `REQUEST_REMOVE` permission. A new global setting auto-approves removal
requests for media that is not yet available.

## Design decision: separate entity

Removal requests get their own entity/table (`MediaRemovalRequest`) rather than a
`requestType` discriminator on `MediaRequest`.

`MediaRequest` is load-bearing in several places that query it without any type filter.
A discriminator column would make each of these silently wrong rather than a compile
error:

| Location | Failure if discriminator used |
| --- | --- |
| `server/entity/User.ts:273` `getQuota()` | Counts `MediaRequest` rows unfiltered — removal requests would consume users' movie/TV request quotas. |
| `server/subscriber/MediaSubscriber.ts:35` `updateRelatedMediaRequest` | Flips requests in `In([APPROVED, FAILED])` to `COMPLETED` once media reaches `AVAILABLE`/`DELETED` — would auto-complete a pending removal request. |
| `server/subscriber/MediaRequestSubscriber.ts:1046,1007` | `afterInsert`/`afterUpdate` unconditionally call `sendToRadarr` → `sendToSonarr`; every path needs a guard. |
| `server/entity/MediaRequest.ts:202-236` | Duplicate detection treats any non-DECLINED/non-COMPLETED row as blocking a new request. |
| `server/routes/request.ts:32` (`GET /`), `:338` (`GET /count`) | List filters and counts (which drive the sidebar pending badge) would include removal requests. |
| `server/lib/watchlistsync.ts:82-88`, `server/lib/availabilitySync.ts` | Query `MediaRequest` with no type filter. |

The separate table reuses `MediaRequestStatus` for its state machine so status semantics
stay identical.

## Existing machinery being reused

The destructive half already exists. `DELETE /api/v1/media/:id/file`
(`server/routes/media.ts:203-306`) already:

1. Resolves the correct Radarr/Sonarr server from `media.serviceId` / `media.serviceId4k`,
   falling back to the default server matching `is4k`.
2. Calls `RadarrAPI.removeMovie(tmdbId)` (`server/api/servarr/radarr.ts:272`) or
   `SonarrAPI.removeSeries(tvdbId)` (`server/api/servarr/sonarr.ts:415`). Both hardcode
   `deleteFiles: true, addImportExclusion: false` and swallow a 404 from the arr.
3. For TV, resolves `tvdbId` via TMDB with a fallback to `media.tvdbId`.
4. Sets every `media.seasons[].status/status4k` and `media.status/status4k` to
   `MediaStatus.DELETED`, calls `media.resetServiceData(is4k)`, and saves. The `media` row
   is retained, only flagged.

This body is extracted into a reusable helper (Issue 4) so both the existing route and the
removal-request approval path call the same code.

## Free enum slots (verified)

- `Permission` (`server/lib/permissions.ts`) tops out at `VIEW_BLOCKLIST = 1073741824`
  (bit 30). **Bit 29 (`536870912`) is unused** — nothing in the repo references it.
  Bit 31 (`2147483648`) is unusable: `hasPermission` uses JS `&`, which coerces to signed
  int32.
- `Notification` (`server/lib/notifications/index.ts:6-20`) tops out at
  `MEDIA_AUTO_REQUESTED = 4096`. Next free: `8192`, `16384`, `32768`.

## Auto-approval rules

Both paths are evaluated **at insert time** so that the `@AfterInsert`
`autoapprovalNotification()` hook fires and sends the "automatically approved" variant,
mirroring `MediaRequest.ts:748-753`.

1. **Permission-driven** — mirrors `MediaRequest.ts:374-401`:
   `user.hasPermission([Permission.MANAGE_REQUESTS], { type: 'or' })`. `ADMIN`
   short-circuits to true inside `hasPermission`.
2. **Setting-driven** — `settings.main.autoApproveRemovalWhenUnavailable === true` **and**
   the media is not yet available:
   `media[is4k ? 'status4k' : 'status']` is neither `AVAILABLE` nor `PARTIALLY_AVAILABLE`.
   That covers `UNKNOWN`, `PENDING`, `PROCESSING`.

If either is true, the row is inserted with `status: APPROVED` and
`modifiedBy: <actor or undefined>`.

## Scope boundaries (v1)

- **Whole-title only.** `removeSeries` deletes the entire series; the Sonarr wrapper has
  no per-season delete. Removal is scoped per title per 4K variant. Per-season removal is
  deferred.
- **Original request rows are left intact.** Only the `media` row is flagged `DELETED`,
  matching current `/media/:id/file` behavior. The requests list's existing `deleted`
  filter (`COMPLETED` request + `DELETED` media, `server/routes/request.ts:62-65,92-94`)
  then surfaces unrequested titles with no extra work.
- **Not blocklisting.** Media stays re-requestable — `MediaRequest.request()` already
  resets `DELETED` → `PENDING` (`MediaRequest.ts:174-188`).
- **No media-server-side deletion.** Nothing today calls Plex/Jellyfin/Emby to delete or
  refresh; reconciliation is left to the scheduled scans and `availabilitySync`. Unchanged
  here.

## Work breakdown

Seven vertical slices, each independently reviewable. Dependency order:
4 → 1 → 2, 3 → 5 → 6 → 7.

### 1. Entity + migrations

`server/entity/MediaRemovalRequest.ts`, modeled on `MediaRequest.ts:549-653` and
`Issue.ts`:

| Field | Type / decorator |
| --- | --- |
| `id` | `@PrimaryGeneratedColumn()` |
| `status` | `@Column({ type: 'integer' })` `@Index()`, `MediaRequestStatus` |
| `media` | `@ManyToOne(() => Media, ..., { eager: true, onDelete: 'CASCADE' })` `@Index()` |
| `requestedBy` | `@ManyToOne(() => User, ..., { eager: true, onDelete: 'CASCADE' })` `@Index()` |
| `modifiedBy?` | `@ManyToOne(() => User, { nullable: true, eager: true, onDelete: 'SET NULL' })` `@Index()` |
| `is4k` | `@Column({ default: false })` |
| `type` | `@Column({ type: 'varchar' })`, `MediaType` |
| `createdAt` | `@DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })` |
| `updatedAt` | `@UpdateDateColumn({ type: resolveDbType('datetime') })` |

Add the inverse `@OneToMany` on `Media` (`server/entity/Media.ts`, alongside `requests`
at :110). Do **not** add `cascade: ['remove']` in a way that would delete removal requests
on media clear — `onDelete: 'CASCADE'` at the DB level already covers it.

Migrations: one per dialect with **different timestamps**, class name = PascalCase name +
timestamp, matching `1781732036510-AddIgnoreQuotaToMediaRequest.ts` (sqlite) and
`1781732098511-...` (postgres). Generate with `pnpm migration:generate`; note the sqlite
generator rewrites tables via `temporary_*` copies while postgres emits plain DDL.

### 2. `REQUEST_REMOVE` permission

- `server/lib/permissions.ts`: `REQUEST_REMOVE = 536870912`.
- `src/components/PermissionEdit/index.tsx`: a `messages` name/description pair and a
  `permissionList` entry. The `manageblocklist` group at :342-357 is the closest template.
  Consider `requires: { permissions: [Permission.REQUEST], type: 'or' }` — requesting
  removal only makes sense for users who can request.
- Run `pnpm i18n:extract` to populate `src/i18n/locale/en.json`.

The client imports `Permission` directly from the server via the `@server/*` alias
(`src/hooks/useUser.ts` re-exports it) — there is no mirrored copy to update.

### 3. `autoApproveRemovalWhenUnavailable` setting

- `server/lib/settings/index.ts`: add to `interface MainSettings` (:132-160) and to the
  `Settings` constructor defaults (~:397-435). Default `false` (conservative — deleting
  files is destructive). `mergeSettings` means existing installs pick up the default with
  no settings migration.
- `POST /api/v1/settings/main` blind-merges `req.body`, so no route change.
- `src/components/Settings/SettingsMain/index.tsx`: four touch points — `messages`,
  `initialValues` (~:171-189), the explicit field list in `onSubmit` (~:192-236, **a field
  omitted here silently fails to save**), and a `form-row` checkbox following the
  `versionCheck` pattern at :614-631.
- Only add to `FullPublicSettings` + `get fullPublicSettings()` (:192-220, :708-743) if the
  client needs to predict approval before submitting.

### 4. Extract the arr-removal helper

Refactor the body of `server/routes/media.ts:203-306` into e.g.
`server/lib/mediaRemoval.ts` exporting something like
`removeMediaFromServarr(media: Media, is4k: boolean): Promise<void>`.

Preserve exactly: server resolution order (default matching `is4k`, then override by
`media.serviceId`/`serviceId4k` when `>= 0`), the 409 when no server is configured, the
TMDB `tvdbId` lookup with `media.tvdbId` fallback, the season + media `DELETED` flagging,
`resetServiceData(is4k)`, and the save. Rewire the existing route to call it so behavior is
provably unchanged.

Note the pre-existing permission inconsistency, out of scope to fix here: the route guards
on `Permission.MANAGE_REQUESTS` (`media.ts:205`) while `seerr-api.yml:7253` documents ADMIN
and `ManageSlideOver` gates its buttons on `Permission.ADMIN`.

### 5. Notifications

- `server/lib/notifications/index.ts`: `MEDIA_REMOVAL_PENDING = 8192`,
  `MEDIA_REMOVAL_APPROVED = 16384`, `MEDIA_REMOVAL_DECLINED = 32768`. Add cases to
  `getAdminPermission` (:48-65) returning `Permission.MANAGE_REQUESTS`; without them they
  fall through to `ADMIN`.
- `MediaRemovalRequest`: `@AfterInsert notifyNewRemovalRequest()`,
  `@AfterUpdate notifyApprovedOrDeclined(autoApproved)`,
  `@AfterInsert autoapprovalNotification()`, and a static `sendNotification` with the
  `event`/`notifyAdmin`/`notifySystem` switch — all modeled on
  `MediaRequest.ts:655-863`.
- `src/components/NotificationTypeSelector/index.tsx`: the enum is **hand-duplicated** at
  :95-109 — mirror the three new members, add `NotificationItem` entries to the `types`
  array (:198-358) and message pairs (:10-67).
- Per-agent switches, all needing new cases: `discord.ts:115-137`, `email.ts:136-185`,
  `gotify.ts:67-84`, `ntfy.ts:49-66`, `pushbullet.ts:60-82`, `pushover.ts:112-136`,
  `slack.ts:82-99`, `telegram.ts:91-114`, `webpush.ts:96-173`. `webhook.ts` needs nothing
  (uses `Notification[type]` reverse-mapping).
  - **`webpush.ts` has a `default:` branch that silently renders `subject: 'Unknown'`** —
    easy to miss.
  - **`email.ts` needs both 4K and non-4K message variants** in its `messages` block
    (:22-61). The `media-request` pug template needs no branching; it renders the `event`
    string.
- `public/sw.js` (:97,113-114,123) string-compares `notificationType` for Approve/Decline
  push actions and badge behavior — extend only if removal requests need push actions.

### 6. API routes + subscriber

`server/routes/removalRequest.ts`, mounted in `server/routes/index.ts` alongside
`router.use('/request', isAuthenticated(), requestRoutes)` (:159):

| Route | Auth | Behavior |
| --- | --- | --- |
| `POST /` | `REQUEST_REMOVE` | Body `{ mediaId, is4k? }`. Caller must own a non-declined `MediaRequest` for that media/`is4k` (or hold `MANAGE_REQUESTS`). Reject duplicates (existing PENDING removal request). Reject when media is already `DELETED`/`UNKNOWN`. Apply auto-approval rules at insert. `201`. |
| `GET /` | `isAuthenticated()` | Paginated list; non-`MANAGE_REQUESTS`/`REQUEST_VIEW` users forced to own rows, mirroring `request.ts:141-161`. |
| `GET /:id` | owner or `MANAGE_REQUESTS`/`REQUEST_VIEW` | |
| `POST /:id/:status` | `MANAGE_REQUESTS` | `pending`/`approve`/`decline` → sets `status` + `modifiedBy`. Give the `switch` a `default` that 400s — `request.ts:680-690` lacks one and writes `undefined`. |
| `DELETE /:id` | `MANAGE_REQUESTS`, or owner while `PENDING` | Withdraw. |

`server/subscriber/MediaRemovalRequestSubscriber.ts` — auto-discovered via
`subscribers: ['server/subscriber/**/*.ts']` (`datasource.ts:58`). On `afterInsert` /
`afterUpdate` with `status === APPROVED`, call the Issue-4 helper. On failure, set
`status = FAILED` and send `MEDIA_FAILED`, mirroring the `sendToRadarr` error handling at
`MediaRequestSubscriber.ts:402-470`. Wrap in try/catch and log — never let a subscriber
throw past the save.

Tests in `server/routes/removalRequest.test.ts` following `request.test.ts` (node:test +
supertest + `setupTestDb`, with `sendNotification` mocked). Cover: permission denial,
non-owner rejection, duplicate rejection, permission auto-approve, setting auto-approve
for unavailable media, no auto-approve when available, and approve → helper invoked.

Update `seerr-api.yml` with the new paths and schema.

### 7. Client UI

- `src/components/RequestButton/index.tsx`: add an "Unrequest" / "Request Removal" option.
  The `buttons: ButtonOption[]` array pattern (:125+) makes this additive. Show when the
  user has `REQUEST_REMOVE`, owns a request for the media, media is not already `DELETED`,
  and no removal request is pending.
- A confirm modal — deleting files is destructive. Copy must say files will be deleted from
  Radarr/Sonarr. `ConfirmButton` is used for the analogous admin action in
  `RequestList/RequestItem/index.tsx:717`.
- Surface pending removal requests for approvers. Cheapest path consistent with the
  scope decision: a dedicated list/section reusing `RequestList` patterns. Optionally
  union removal requests into `GET /request` for display only.
- `src/i18n/locale/en.json` via `pnpm i18n:extract`.

## Verification

```
pnpm lint
pnpm typecheck
pnpm test
pnpm migration:run   # against a scratch copy of both sqlite and postgres
```

Manual: request a movie as a non-admin with `REQUEST_REMOVE`; unrequest it while
`PROCESSING` with the setting on (expect auto-approve + removal from Radarr + files gone +
media `DELETED`); unrequest an `AVAILABLE` title with the setting on (expect PENDING +
admin notification); approve it and confirm removal; re-request the title and confirm it
returns to `PENDING`.
