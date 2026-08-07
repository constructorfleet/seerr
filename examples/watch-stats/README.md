# Watch Stats — an extension that integrates external services

Brings user viewing statistics into Seerr: what each person has watched, what is
trending on the server, and what to watch next based on both.

Where [`watch-history`](../watch-history) exists to exercise every capability the
SDK has, this one answers a narrower question: **what does an extension look like
when the data lives somewhere else?** It reads plays from either
[Tautulli](https://tautulli.com) or [Tracearr](https://github.com/connorgallopo/Tracearr),
and the contrast between those two halves is the whole point.

| | Tautulli | Tracearr |
| --- | --- | --- |
| Does core know about it? | Yes — Settings → Services | No |
| Who holds the credential? | Seerr | this extension |
| How the extension reaches it | `sdk.tautulli` | its own `fetch` |
| Identifies a title by | Plex rating key | TMDB id |
| Reports watch time in | seconds (converted by the host) | milliseconds |
| Adapter | `src/sources/tautulli.ts`, ~90 lines | `src/sources/tracearr.ts`, ~175 |

The size difference is the argument for host capabilities. `sdk.tautulli` is
read-only and manifest-gated (`requires: { tautulli: 'read' }`) and hands over
records already normalized, so the Tautulli adapter contains no hostname, no port,
no API key and no HTTP call. The Tracearr adapter has to do all of it — auth,
cursor pagination, a page cap, response validation, and deciding what an
unreachable server means.

**`sdk.tautulli` is the one capability whose declaration does not guarantee
presence.** The operator must *also* have configured Tautulli in Seerr's settings,
so the member is optional and `src/index.ts` checks for it. That is why an
unconfigured source is a state with a sentence attached (`sourceProblem`, rendered
by the panel) rather than an error.

## Configuring

Under Settings → Extensions → Watch Stats:

| Setting | Notes |
| --- | --- |
| `source` | `tautulli` or `tracearr` |
| `tracearr_url` | base URL, trailing slash tolerated. Only for `tracearr` |
| `tracearr_token` | a `trr_pub_…` token from Tracearr's Settings → General |
| `trend_days` | the window plays are counted over, 1–90 (default 7) |

Choosing `tautulli` needs nothing here — the connection is core's, under
Settings → Services.

The manifest declares **no `requires.http` allowlist**, deliberately. Both
services live at an address the operator chooses, so there is no hostname the
author could list; a plausible-looking placeholder would make the one file whose
job is to describe truthfully what an extension touches into a lie.

## Building and installing

```
pnpm build      # both tsconfigs — CJS entry point, ESM panel
pnpm typecheck
cp -r . "${CONFIG_DIRECTORY:-config}/extensions/watch-stats"
# then restart Seerr and enable it under Settings → Extensions
```

Restarting is required: TypeORM cannot register an entity after
`DataSource.initialize()`, so the `ext_watch-stats_play` table is only picked
up at boot. The two-tsconfig split is explained in `watch-history`'s README and
matters for the same reasons here.

## Four things worth reading the comments for

1. **The stored table is an aggregate, not a play log.** Neither source exposes a
   stable per-play id, so there is nothing to deduplicate an incremental sync
   against. `sync` therefore recomputes the window and replaces the table inside
   one transaction — which makes running it twice indistinguishable from running
   it once, and makes a failed sync leave the previous numbers in place rather
   than emptying the panel. See `src/entity/PlayStat.ts` and `sync` in
   `src/index.ts`.
2. **A source's identifiers are not core's.** A play arrives keyed by a rating key
   *or* a tmdbId, and by a *media-server* user id. `sdk.media.findByRatingKey` /
   `findByTmdbId` and the `plexId → user.id` map are what turn those into the only
   durable keys worth storing. A play that resolves to neither is dropped, not
   stored under a guess — someone watching without a Seerr account, or a title
   added to the library outside Seerr, are both ordinary states.
3. **Episodes count against the series.** Tautulli reports episode plays
   individually; core's `media` row is the series. Both adapters fold `episode`
   into `tv` and key on the series, so twelve episodes are twelve plays of one
   title rather than twelve titles core has no row for.
4. **The panel imports `@constructorfleet/extension-ui` instead of writing Tailwind.** This
   is the only example that does, and it is the right way. `tailwind.config.js`
   scans `src/pages/**` and `src/components/**`, so a class appearing *only* in a
   runtime-loaded panel bundle is never compiled — the element renders unstyled
   with no console error and no log line. Importing core's own components sidesteps
   the whole class of bug; see the header of `src/panel.tsx`.

## Where the tests are

`server/lib/extensions/watchStats.test.ts`, in the Seerr repo — an integration
test that builds this example with its own `tsc`, installs the output into a
temporary directory, and drives it through the real loader. It fakes Tautulli at
core's `TautulliAPI` prototype and Tracearr at `globalThis.fetch`, then asserts the
joins, the idempotency, the permission gate and the manifest agreement above.
