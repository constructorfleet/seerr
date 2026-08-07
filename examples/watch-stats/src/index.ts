/**
 * Watch Stats — the second example extension.
 *
 * Where `watch-history` exercises every capability the SDK has, this one exists to
 * answer a narrower question honestly: **what does an extension look like when it
 * integrates an external service?** Two of them, in fact, which is the point —
 * Tautulli is something core already knows about, Tracearr is not, and the two
 * halves of `src/sources/` show how differently that plays out.
 *
 * The shape it demonstrates, in the order the code below does it:
 *
 * 1. **Resolve a source, or explain why not.** Both are optional and neither is
 *    configured on a fresh install, so "no source" is a state with a sentence
 *    attached rather than a crash. See {@link resolveSource}.
 * 2. **Aggregate, then join to core.** The sources report plays keyed by *their*
 *    identifiers; `sdk.media.findByRatingKey` / `findByTmdbId` are what turn those
 *    into core media ids, which is the only durable key to store.
 * 3. **Recompute and replace.** The stored table is an aggregate per (user, media),
 *    so the job is idempotent — see `entity/PlayStat.ts` for why a play log would
 *    not be.
 * 4. **Suggest from what was watched.** `sdk.discover` turns the most-played titles
 *    into recommendations without this extension shipping a TMDB key.
 *
 * `export =` rather than `export default`: the loader reads `module.exports.default`
 * for the setup function and `module.exports.entities` for the entities, so
 * `export default defineExtension(...)` would nest both one level too deep.
 */
import type {
  ExtensionMediaDetails,
  NarrowedExtensionSdk,
  SeerrUser,
} from '@constructorfleet/extension-sdk';
import { defineExtension } from '@constructorfleet/extension-sdk';
import { z } from 'zod';

import { PlayStat } from './entity/PlayStat';
import { manifest } from './manifest';
import { CreatePlayStat1786000000000 } from './migration/1786000000000-CreatePlayStat';
import { tautulliSource } from './sources/tautulli';
import { tracearrSource } from './sources/tracearr';
import type { SourceResolution, WatchSource } from './sources/types';

/** The kv key holding the last successful sync, for the panel's footer. */
const LAST_SYNC_KEY = 'lastSync';

/** How many titles the suggestion list draws from, and how many it returns. */
const SEED_TITLES = 3;
const MAX_SUGGESTIONS = 20;

type Sdk = NarrowedExtensionSdk<typeof manifest>;

const statsQuery = z.object({
  userId: z.coerce.number().int().positive().optional(),
});

export = defineExtension({
  manifest,
  entities: [PlayStat],
  migrations: [CreatePlayStat1786000000000],
  setup(sdk: Sdk) {
    const stats = () => sdk.store.getRepository(PlayStat);

    /**
     * Which source to read, or why there is none.
     *
     * Returns a reason rather than throwing, and the reasons are written for the
     * *operator* — this string reaches the panel. An extension whose external
     * dependency is unconfigured has to be able to say so; "Cannot read property
     * 'plays' of undefined" in a log the operator never opens is the failure mode
     * this exists to avoid.
     */
    const resolveSource = async (): Promise<SourceResolution> => {
      const source = sdk.settings.own.source ?? 'tautulli';

      if (source === 'tracearr') {
        const url = sdk.settings.own.tracearr_url;
        const token = sdk.settings.own.tracearr_token;

        if (typeof url !== 'string' || !url) {
          return {
            ok: false,
            reason: 'Set the Tracearr URL in this extension’s settings.',
          };
        }

        if (typeof token !== 'string' || !token) {
          return {
            ok: false,
            reason: 'Set a Tracearr API token in this extension’s settings.',
          };
        }

        return {
          ok: true,
          source: tracearrSource({
            url,
            token,
            warn: (message, meta) => sdk.logger.warn(message, meta),
          }),
        };
      }

      // `sdk.tautulli` is absent when the operator has not configured Tautulli in
      // *Seerr's* settings — the manifest declaring `requires.tautulli` is not
      // enough, which is exactly why the SDK leaves the member optional.
      if (!sdk.tautulli) {
        return {
          ok: false,
          reason:
            'Configure Tautulli in Seerr’s settings, or switch this extension’s source to Tracearr.',
        };
      }

      return {
        ok: true,
        source: tautulliSource(sdk.tautulli, await syncableUsers()),
      };
    };

    /**
     * Every user with a media-server id, which is every user a source can report
     * plays for.
     *
     * `sdk.users` has no `list`, so this walks ids until it runs dry — deliberately
     * left as the naive loop rather than papered over, because it is the honest
     * cost of the capability as it stands and the place a `users.list` would earn
     * its keep. Bounded so a gap in the id sequence cannot make it walk forever.
     */
    const syncableUsers = async (): Promise<SeerrUser[]> => {
      const users: SeerrUser[] = [];
      let misses = 0;

      for (let id = 1; id <= 10_000 && misses < 50; id++) {
        const user = await sdk.users.get(id);

        if (!user) {
          misses++;
          continue;
        }

        misses = 0;

        if (user.plexId != null) {
          users.push(user);
        }
      }

      return users;
    };

    /** The window the sources are asked about, from the operator's setting. */
    const since = (): Date => {
      const days =
        typeof sdk.settings.own.trend_days === 'number'
          ? sdk.settings.own.trend_days
          : 7;

      return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    };

    /**
     * Reads a source and replaces this extension's aggregate table with what it
     * reported.
     *
     * The join is the interesting half. A source names a title by whichever
     * identifier it has, and a *user* by their media-server id — so both have to be
     * resolved against core before anything can be stored, and a play that resolves
     * to neither is dropped rather than stored under a guess.
     */
    const sync = async (source: WatchSource): Promise<number> => {
      const users = await syncableUsers();
      // Plex id → Seerr id. Built once; the alternative is a `users.get` per play.
      const byPlexId = new Map(
        users
          .filter((user) => user.plexId != null)
          .map((user) => [user.plexId as number, user.id])
      );

      const plays = await source.plays(since());
      const rows: PlayStat[] = [];
      const syncedAt = new Date();

      for (const play of plays) {
        const userId = byPlexId.get(play.sourceUserId);

        if (!userId) {
          // A media-server user with no Seerr account. Not an error — plenty of
          // people watch without ever signing in to Seerr — and nothing to store.
          continue;
        }

        const media = play.ratingKey
          ? await sdk.media.findByRatingKey(play.ratingKey)
          : play.tmdbId
            ? await sdk.media.findByTmdbId(play.tmdbId, play.mediaType)
            : null;

        if (!media) {
          // Watched, but not something Seerr has a row for — someone added it to
          // the library outside Seerr. Skipped, because every stored row is keyed
          // on a core media id.
          continue;
        }

        rows.push(
          new PlayStat({
            userId,
            mediaId: media.id,
            mediaType: play.mediaType,
            plays: play.plays,
            // `bigint` maps to a string; see the column's comment.
            watchTimeMs: String(play.watchTimeMs),
            lastPlayedAt: play.lastPlayedAt ?? null,
            source: source.name,
            syncedAt,
          })
        );
      }

      // Replace rather than upsert. The aggregate is a cache of what the source
      // says *now*, so a title whose plays the source no longer reports (deleted
      // history, a switched source) has to disappear rather than linger at its
      // last-known count. Doing it in one transaction means a failed sync leaves
      // the previous numbers intact instead of an empty panel.
      await sdk.store.dataSource.transaction(async (manager) => {
        await manager.clear(PlayStat);

        if (rows.length) {
          await manager.save(rows);
        }
      });

      await sdk.store.kv.set(LAST_SYNC_KEY, syncedAt.getTime());

      return rows.length;
    };

    /**
     * Decorates stored rows with something a person recognizes.
     *
     * The extension's backend does this, not its panel: the panel is handed titles
     * and poster URLs, never a tmdbId and the TMDB path conventions. That is the
     * rule the whole SDK is shaped around — an extension is a backend that may
     * have a UI.
     */
    const withDetails = async (rows: PlayStat[]) =>
      Promise.all(
        rows.map(async (row) => ({
          mediaId: row.mediaId,
          mediaType: row.mediaType,
          plays: row.plays,
          watchTimeMs: Number(row.watchTimeMs),
          lastPlayedAt: row.lastPlayedAt,
          details: await sdk.media.getDetails(row.mediaId),
        }))
      );

    // #region routes

    /** The panel's main read: this user's titles, most-played first. */
    sdk.router.get('/stats', { permission: 'view_own' }, async (req, res) => {
      const parsed = statsQuery.safeParse(req.query);

      if (!parsed.success) {
        res.status(400).json({ message: 'Invalid query.' });
        return;
      }

      const signedIn = req.user as { id: number };
      const userId = parsed.data.userId ?? signedIn.id;

      // Checked here rather than declared on the route, because *which* permission
      // is needed depends on the query — route options cannot express that.
      if (
        userId !== signedIn.id &&
        !(await sdk.users.hasPermission(signedIn.id, 'view_all'))
      ) {
        res.status(403).json({ message: 'You cannot view those stats.' });
        return;
      }

      const rows = await stats().find({
        where: { userId },
        order: { plays: 'DESC' },
        take: 50,
      });

      const resolution = await resolveSource();

      res.status(200).json({
        results: await withDetails(rows),
        // The panel shows which server the numbers came from, and core's Tautulli
        // connection is the only place that hostname exists.
        source: resolution.ok ? resolution.source.name : null,
        sourceProblem: resolution.ok ? null : resolution.reason,
        tautulliHost: sdk.settings.tautulli?.hostname ?? null,
        lastSync: await sdk.store.kv.get<number>(LAST_SYNC_KEY),
      });
    });

    /**
     * What is trending *on this server* — the roll-up across all users.
     *
     * `view_all`, because it is derived from everyone's viewing. A user's own
     * counts are theirs; the aggregate is not.
     */
    sdk.router.get(
      '/trending',
      { permission: 'view_all' },
      async (_req, res) => {
        // Grouped in SQL rather than by loading every row: the table is bounded by
        // users × titles, which is small, but "small" is the operator's library and
        // not something an extension should assume.
        const rows = await stats()
          .createQueryBuilder('stat')
          .select('stat.mediaId', 'mediaId')
          .addSelect('stat.mediaType', 'mediaType')
          .addSelect('SUM(stat.plays)', 'plays')
          .addSelect('COUNT(DISTINCT stat.userId)', 'viewers')
          .groupBy('stat.mediaId')
          .addGroupBy('stat.mediaType')
          .orderBy('plays', 'DESC')
          .limit(20)
          .getRawMany<{
            mediaId: number;
            mediaType: 'movie' | 'tv';
            // `SUM`/`COUNT` come back as strings on some drivers and numbers on
            // others, so both are coerced below rather than trusted.
            plays: string | number;
            viewers: string | number;
          }>();

        res.status(200).json({
          results: await Promise.all(
            rows.map(async (row) => ({
              mediaId: row.mediaId,
              mediaType: row.mediaType,
              plays: Number(row.plays),
              viewers: Number(row.viewers),
              details: await sdk.media.getDetails(row.mediaId),
            }))
          ),
        });
      }
    );

    /**
     * "Because you watched…" — the half of this extension `sdk.discover` exists
     * for.
     *
     * TMDB's recommendations for the user's most-played titles, minus anything
     * they have already watched. Titles core has no row for are *kept*: the whole
     * value of a suggestion is that it is something you do not have yet.
     */
    sdk.router.get(
      '/suggestions',
      { permission: 'view_own' },
      async (req, res) => {
        const signedIn = req.user as { id: number };

        const seeds = await stats().find({
          where: { userId: signedIn.id },
          order: { plays: 'DESC' },
          take: SEED_TITLES,
        });

        const watched = new Set(
          (await stats().find({ where: { userId: signedIn.id } })).map(
            (row) => row.mediaId
          )
        );

        // Deduplicated across seeds by tmdbId: three related films recommend each
        // other, so without this the list is the same handful repeated.
        const suggestions = new Map<number, ExtensionMediaDetails>();

        for (const seed of seeds) {
          const media = await sdk.media.get(seed.mediaId);

          if (!media?.tmdbId) {
            continue;
          }

          // `recommendations` rather than `similar`: TMDB's recommendations carry a
          // popularity signal, similar titles are keyword overlap alone. Falling
          // back to `similar` when a title is too obscure to have any.
          const related = await sdk.discover.recommendations(
            media.tmdbId,
            seed.mediaType
          );
          const results = related.length
            ? related
            : await sdk.discover.similar(media.tmdbId, seed.mediaType);

          for (const result of results) {
            if (suggestions.size >= MAX_SUGGESTIONS) {
              break;
            }

            const existing = await sdk.media.findByTmdbId(
              result.tmdbId,
              seed.mediaType
            );

            // Only *watched* titles are excluded, not everything core knows about:
            // a film sitting unwatched in the library is a perfectly good
            // suggestion, and arguably the best one.
            if (existing && watched.has(existing.id)) {
              continue;
            }

            suggestions.set(result.tmdbId, result);
          }
        }

        res.status(200).json({ results: [...suggestions.values()] });
      }
    );

    // #endregion

    /**
     * The sync, on the manifest's hourly schedule.
     *
     * An unconfigured source is logged at `info` and *not* an error: it is the
     * state of every fresh install, and a job that errors hourly because the
     * operator has not finished setting up trains them to ignore the log.
     */
    sdk.jobs.register('sync', async () => {
      const resolution = await resolveSource();

      if (!resolution.ok) {
        sdk.logger.info('Skipping watch-stats sync', {
          reason: resolution.reason,
        });
        return;
      }

      try {
        const rows = await sync(resolution.source);

        sdk.logger.info('Watch stats sync complete', {
          source: resolution.source.name,
          rows,
        });
      } catch (e) {
        // Caught so one unreachable source does not take out the job runner. The
        // previous numbers survive — see the transaction in `sync`.
        sdk.logger.error('Watch stats sync failed', {
          source: resolution.source.name,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
    });
  },
});
