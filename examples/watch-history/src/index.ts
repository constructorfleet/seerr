/**
 * Watch History — the reference extension.
 *
 * Its job is to be the honest end-to-end exercise of the SDK: every capability
 * the manifest can declare is declared and actually used here (`store`, `users`,
 * `media`, `requests`, `settings`, `jobs`, events, routes, a panel, its own
 * permissions and its own notification type). If the SDK is missing something an
 * extension needs, this is where it shows up.
 *
 * `export =` rather than `export default`: the loader reads
 * `module.exports.default` for the setup function and `module.exports.entities`
 * for the entities, so `export default defineExtension(...)` would nest both one
 * level too deep — putting an object where the loader looks for a function.
 */
import { defineExtension } from '@seerr/extension-sdk';
import { z } from 'zod';

import { WatchEvent } from './entity/WatchEvent';
import { manifest } from './manifest';
import { CreateWatchEvent1754280000000 } from './migration/1754280000000-CreateWatchEvent';

/**
 * How many watched items earn a `milestone` notification. Round numbers only, so
 * that a user who watches a lot is not notified constantly.
 */
const MILESTONES = [1, 10, 50, 100, 250, 500, 1000];

/** The kv key holding the last time `sync` pruned. Read by the panel's summary. */
const LAST_SYNC_KEY = 'lastSync';

const recordBody = z.object({
  mediaId: z.number().int().positive(),
  mediaType: z.enum(['movie', 'tv']),
  /** Epoch millis. Defaults to now, so the panel's usual case sends only ids. */
  watchedAt: z.number().int().positive().optional(),
});

const historyQuery = z.object({
  userId: z.coerce.number().int().positive().optional(),
  take: z.coerce.number().int().positive().max(100).optional(),
});

export = defineExtension({
  manifest,
  entities: [WatchEvent],
  migrations: [CreateWatchEvent1754280000000],
  setup(sdk) {
    // Non-optional because the manifest declares them. That narrowing is the
    // entire reason `defineExtension` exists — see its doc comment.
    const events = () => sdk.store.getRepository(WatchEvent);

    /**
     * Records a watch, and notifies on a milestone.
     *
     * Deduplicated on (`userId`, `mediaId`) for event-sourced rows: core can emit
     * `media.available` more than once for the same media (4K and non-4K are
     * separate transitions), and a history that lists the same film twice because
     * of that is wrong in a way the user cannot explain. A `manual` row is never
     * deduplicated — rewatching is the point.
     */
    const record = async (
      userId: number,
      mediaId: number,
      mediaType: 'movie' | 'tv',
      source: 'event' | 'manual',
      watchedAt = new Date()
    ): Promise<WatchEvent | undefined> => {
      if (source === 'event') {
        const existing = await events().findOne({
          where: { userId, mediaId, source: 'event' },
        });

        if (existing) {
          return undefined;
        }
      }

      const media = await sdk.media.get(mediaId);

      const saved = await events().save(
        new WatchEvent({
          userId,
          mediaId,
          mediaType,
          tmdbId: media?.tmdbId ?? null,
          source,
          watchedAt,
        })
      );

      await notifyMilestone(userId);

      return saved;
    };

    const notifyMilestone = async (userId: number): Promise<void> => {
      const total = await events().count({ where: { userId } });

      if (!MILESTONES.includes(total)) {
        return;
      }

      const user = await sdk.users.get(userId);

      if (!user) {
        return;
      }

      // `notifyUser` is what makes this reach the user rather than only admins.
      // Delivery still depends on them holding a subscription to
      // `watch-history:milestone` *and* having the core extension sentinel on for
      // an agent — the host resolves both; nothing here needs to know.
      await sdk.notify.send('milestone', {
        subject: `${total} watched`,
        message: `${user.displayName ?? user.email} has watched ${total} items.`,
        notifyUser: user,
        extra: [
          { name: 'Application', value: sdk.settings.main.applicationTitle },
        ],
      });
    };

    // #region events

    /**
     * `request.available` rather than `media.available`, because a *request*
     * carries the user who wanted the thing. `media.available` says a title
     * became available to everyone and names nobody, so there is no watch to
     * attribute — which is why this extension listens to both but only writes
     * rows from the former.
     */
    sdk.events.on('request.available', async ({ request }) => {
      if (!request.requestedBy || !request.media) {
        return;
      }

      await record(
        request.requestedBy.id,
        request.media.id,
        request.media.mediaType,
        'event'
      );
    });

    sdk.events.on('media.available', ({ media, is4k }) => {
      // Deliberately only logged. Attributing this to a user would mean guessing
      // one; see the comment above.
      sdk.logger.debug('Media became available', {
        mediaId: media.id,
        is4k,
      });
    });

    // #endregion

    // #region routes

    /**
     * The panel's main read. Gated on `view_own`, and a request for *another*
     * user's history additionally requires `view_all` — checked here rather than
     * declared on the route, because which permission is needed depends on the
     * query, which route options cannot express.
     */
    sdk.router.get('/history', { permission: 'view_own' }, async (req, res) => {
      const parsed = historyQuery.safeParse(req.query);

      if (!parsed.success) {
        res.status(400).json({ message: 'Invalid query.' });
        return;
      }

      // `req.user` is present because the route declares a permission, so the
      // host rejected the unauthenticated case before this handler ran.
      const signedIn = req.user as { id: number };
      const { userId = signedIn.id, take = 50 } = parsed.data;

      if (
        userId !== signedIn.id &&
        !(await sdk.users.hasPermission(signedIn.id, 'view_all'))
      ) {
        res.status(403).json({ message: 'You cannot view that history.' });
        return;
      }

      const rows = await events().find({
        where: { userId },
        order: { watchedAt: 'DESC' },
        take,
      });

      res.status(200).json({
        results: rows,
        lastSync: await sdk.store.kv.get<number>(LAST_SYNC_KEY),
      });
    });

    /** Records a rewatch from the panel. */
    sdk.router.post(
      '/history',
      { permission: 'view_own', body: recordBody },
      async (req, res) => {
        const signedIn = req.user as { id: number };
        const { mediaId, mediaType, watchedAt } = req.body;

        const saved = await record(
          signedIn.id,
          mediaId,
          mediaType,
          'manual',
          watchedAt ? new Date(watchedAt) : undefined
        );

        res.status(201).json(saved);
      }
    );

    /**
     * What the requests capability is for: "you requested this and it arrived,
     * but you have no watch row for it". The panel's suggestion list.
     */
    sdk.router.get(
      '/unwatched',
      { permission: 'view_own' },
      async (req, res) => {
        const signedIn = req.user as { id: number };

        const requests = await sdk.requests.list({
          userId: signedIn.id,
          take: 100,
        });
        const watched = new Set(
          (await events().find({ where: { userId: signedIn.id } })).map(
            (row) => row.mediaId
          )
        );

        res.status(200).json({
          results: requests
            .filter(
              (request) => request.media && !watched.has(request.media.id)
            )
            .map((request) => ({
              mediaId: request.media.id,
              mediaType: request.media.mediaType,
              tmdbId: request.media.tmdbId,
            })),
        });
      }
    );

    // #endregion

    /**
     * Housekeeping, on the manifest's schedule.
     *
     * The prune is the reason this job exists: `userId` is a plain column with no
     * foreign key (see `WatchEvent`), so a deleted user's rows would otherwise
     * accumulate forever and show up in a `view_all` listing under an id that
     * resolves to nobody.
     */
    sdk.jobs.register('sync', async () => {
      const userIds = new Set<number>();

      for (const row of await events().find({ select: { userId: true } })) {
        userIds.add(row.userId);
      }

      let pruned = 0;

      for (const userId of userIds) {
        if (!(await sdk.users.get(userId))) {
          const { affected } = await events().delete({ userId });
          pruned += affected ?? 0;
        }
      }

      await sdk.store.kv.set(LAST_SYNC_KEY, Date.now());

      sdk.logger.info('Watch history sync complete', { pruned });
    });
  },
});
