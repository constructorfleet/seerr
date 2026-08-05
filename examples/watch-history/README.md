# Watch History — reference Seerr extension

Records what each user has watched, and shows them their own history in a panel.

Its real job is to be the honest end-to-end exercise of the extension SDK. Every
capability a manifest can declare is declared here **and actually used**, so if
the SDK is missing something an extension needs, this is where it shows up:

| Capability | Where it is used |
| --- | --- |
| `store` (entity) | `src/entity/WatchEvent.ts`, one `ext_watch-history_event` table |
| `store.kv` | the `sync` job's cursor, read back by the panel |
| `users: read` | `hasPermission` for `view_all`; the job's orphan check |
| `media: read` | resolving a `tmdbId` when recording a watch |
| `requests: read` | the `/unwatched` route |
| `settings: read` | `applicationTitle` in the notification |
| `jobs` | `sync`, on the manifest's cron schedule |
| events | `request.available` (writes rows), `media.available` (logged) |
| routes | `GET/POST /history`, `GET /unwatched` |
| permissions | `view_own` (default) and `view_all` (`requiresCore: MANAGE_USERS`) |
| notifications | `milestone` |
| panel | `dist/panel.js`, sidebar `ClockIcon` |

## Building

```
pnpm build      # both halves; see below for why there are two
pnpm typecheck
```

Two tsconfigs, and this is not incidental:

- **`tsconfig.json` → CommonJS.** The host `require()`s the entry point, and the
  `export =` in `src/index.ts` only means anything under CJS emit.
- **`tsconfig.panel.json` → ES2022 modules.** The panel is loaded by a browser
  `import()`. `module: ES2022` is chosen so `tsc` emits bare `from "react"` and
  leaves it alone — those specifiers are exactly what the host's import map
  rewrites to *its* React. A bundler that inlined React would give the panel a
  second copy, which renders correctly and then dies on the first hook.

## Installing

```
# from a checkout
pnpm build
cp -r . "${CONFIG_DIRECTORY:-config}/extensions/watch-history"
# then restart Seerr and enable it under Settings → Extensions
```

Restarting is required, not a formality: TypeORM cannot register an entity after
`DataSource.initialize()`, so an extension contributing a table is only picked up
at boot.

## Three things worth reading the comments for

These are the parts that surprised the author, and each is explained where it
happens rather than here:

1. **`watchedAt` goes through the SDK's `DbAwareColumn`, and the migration through
   `resolveColumnType`** — sqlite and Postgres disagree about date types, so a bare
   `type: 'datetime'` works on a sqlite dev box and fails on a Postgres
   deployment. Both halves must make the same decision or the migrated schema and
   the entity metadata disagree; the decorator covers the entity and the string
   form covers the raw SQL. See `src/entity/WatchEvent.ts` and
   `src/migration/`.
2. **The manifest exists twice** — `seerr-extension.json` (what the host reads)
   and `src/manifest.ts` (what `defineExtension` narrows from). JSON imports widen
   `true` to `boolean`, which silently defeats the narrowing entirely. See
   `src/manifest.ts`; a test in the Seerr repo asserts the two agree.
3. **`userId`/`mediaId` are plain columns, not relations** — a foreign key from an
   extension table into a core one makes uninstalling a schema problem for core
   rather than a `DROP TABLE`. The cost is orphan rows, which the `sync` job
   prunes.
