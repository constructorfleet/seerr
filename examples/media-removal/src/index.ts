/**
 * Media Removal Requests — "unrequests", as an extension.
 *
 * A user who requested something can ask for it to be deleted again. The request
 * behaves like an ordinary media request: it can be pending, approved, declined
 * or auto-approved, and each transition notifies. Approving it deletes the media
 * from Radarr/Sonarr, files included, and flags core's `media` row `DELETED`.
 *
 * ## The two audiences are separated by permission, not by screen
 *
 * A user holding `request` sees the panel, and in it only their own rows and a
 * picker over their own core requests. Asking for a removal never does anything
 * except mark it for an admin to review — there is no path by which a requester's
 * click deletes a file.
 *
 * A user holding `manage` sees every row plus the approve/decline controls, which
 * is the review queue. The one switch that lets a removal skip that queue is an
 * *operator* setting on `/settings/extensions/media-removal`, behind core's
 * `ADMIN` gate, and it is not reachable from the panel at all — see `SETTING_KEY`.
 * Holding `manage` does not auto-approve your own request: you ask like everyone
 * else and then approve it from the queue, so the queue is a complete record of
 * what was deleted and who decided.
 *
 * ## Why this is an extension and not a core feature
 *
 * It was drafted as one. The core version needed a new entity with relations into
 * `Media` and `User`, a new `Permission` bit, a new `MainSettings` field with four
 * client-side touch points, three new `Notification` bits, and a new `case` in each
 * of nine notification agents — a diff that touched a dozen files core already had
 * for other reasons, for a feature many installs will never turn on. As an
 * extension it is this directory, and core keeps exactly one thing: the removal
 * itself, behind `sdk.media.remove`.
 *
 * That boundary is the interesting part of this example. **The extension never
 * constructs a RadarrAPI and never gets a repository for core's `Media`.** It asks
 * the host to run its own removal — the same `removeMediaFromServarr` path
 * `DELETE /api/v1/media/:id/file` runs — which is what makes a destructive
 * capability reviewable: the audit surface is one host function, not an
 * extension's copy of the Radarr-versus-Sonarr branching.
 *
 * ## What had to change from the core design
 *
 * Three things could not be carried across, and each is documented where it
 * happens rather than here:
 *
 * - **Notifications are the extension's own keys**, not core `Notification` bits.
 *   See `manifest.ts`; bit 8192, which the core draft claimed, is now
 *   `Notification.EXTENSION`.
 * - **The auto-approval setting is a *declared* setting**, rendered by the host on
 *   the extension's admin page, because core's `MainSettings` is not extensible
 *   from outside. See `SETTING_KEY`.
 * - **`NoServarrServerError` is recognized structurally**, by its `arrName`
 *   property, because an extension cannot import from `@server/*`. See
 *   `describeFailure`.
 *
 * `export =` rather than `export default`: the loader reads
 * `module.exports.default` for the setup function and `module.exports.entities`
 * for the entities, so `export default defineExtension(...)` would nest both one
 * level too deep.
 */
import { defineExtension } from '@seerr/extension-sdk';
import { z } from 'zod';

import type { RemovalRequestStatusValue } from './entity/RemovalRequest';
import { RemovalRequest, RemovalRequestStatus } from './entity/RemovalRequest';
import { manifest } from './manifest';
import { CreateRemovalRequest1785600000000 } from './migration/1785600000000-CreateRemovalRequest';

/**
 * Core `MediaStatus` values this extension needs to reason about, restated for
 * the same reason `RemovalRequestStatus` is: `@server/constants/media` is not
 * importable from an extension. Only the three that matter are named — the
 * numbering is core's.
 */
const MediaStatus = {
  UNKNOWN: 1,
  PARTIALLY_AVAILABLE: 4,
  AVAILABLE: 5,
  DELETED: 7,
} as const;

/** Core `MediaRequestStatus.DECLINED`, the one value the ownership check excludes. */
const CORE_REQUEST_DECLINED = 3;

/**
 * The declared-setting key holding "approve removals of media that is not
 * available yet".
 *
 * In core this was `settings.main.autoApproveRemovalWhenUnavailable`. An
 * extension cannot add a field to `MainSettings`: `sdk.settings.main` is
 * read-only and redacted by design, and a writable core settings surface would let
 * any extension change any operator setting — a much larger capability than this
 * feature needs.
 *
 * What it *can* do is declare its own, which is what `provides.settings` in the
 * manifest is. That puts the switch on `/settings/extensions/media-removal`,
 * behind core's `ADMIN` gate, rendered and validated by the host. It is read here
 * through `sdk.settings.own` and written nowhere in this file — an extension does
 * not write its own operator settings, which is the point: the host owns the form,
 * so what the operator sees and what this code reads cannot disagree.
 *
 * This is a deliberate move away from the earlier design, where the switch lived
 * in `ext_kv` and the panel toggled it. Two things were wrong with that. It put a
 * "delete files without review" control on the same screen a requester uses, gated
 * only on an extension permission rather than on `ADMIN`; and because it was kv,
 * *this* extension could rewrite it through `sdk.store.kv` — an operator decision
 * about destructive behaviour, mutable by the code it governs.
 *
 * Absent still means **false**: the manifest declares that default, so an install
 * that has never opened the settings page never auto-deletes anything.
 */
const SETTING_KEY = 'auto_approve_unavailable';

/** The largest page `GET /requests` will serve, whatever `take` asks for. */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

/**
 * Statuses that still stand in the way of a new request for the same media and
 * variant.
 *
 * Narrower than the core draft's, which also blocked on `APPROVED` and
 * `COMPLETED`. Here approval performs the removal synchronously, so an `APPROVED`
 * row is a transient state that only persists when the removal *failed* — and
 * blocking on it would mean a failed removal could never be retried. `COMPLETED`
 * does not block either, because core's `MediaRequest.request()` resets `DELETED`
 * back to `PENDING`: a title can be re-requested and therefore re-unrequested.
 */
const BLOCKING_STATUSES: RemovalRequestStatusValue[] = [
  RemovalRequestStatus.PENDING,
];

const createBody = z.object({
  mediaId: z.number().int().positive(),
  is4k: z.boolean().optional(),
});

const listQuery = z.object({
  take: z.coerce.number().int().positive().optional(),
  skip: z.coerce.number().int().nonnegative().optional(),
});

/** The route param map every `/:id` route reads. */
const idParams = z.object({
  id: z.coerce.number().int().positive(),
});

/**
 * `pending | approve | decline` → a status.
 *
 * A lookup resolved *before* the row is fetched, so an unknown value cannot write
 * anything. The core draft called this out as the one bug worth not repeating:
 * `server/routes/request.ts`'s equivalent `switch` has no `default`, so
 * `POST /request/1/destroy` writes `undefined` into the status column and returns
 * 200.
 */
const STATUS_TRANSITIONS: Record<string, RemovalRequestStatusValue> = {
  pending: RemovalRequestStatus.PENDING,
  approve: RemovalRequestStatus.APPROVED,
  decline: RemovalRequestStatus.DECLINED,
};

export = defineExtension({
  manifest,
  entities: [RemovalRequest],
  migrations: [CreateRemovalRequest1785600000000],
  setup(sdk) {
    // Non-optional because the manifest declares them — including
    // `sdk.media.remove`, which exists on the type only because `requires.media`
    // is the literal `'write'`. That narrowing is the entire reason
    // `defineExtension` exists.
    const requests = () => sdk.store.getRepository(RemovalRequest);

    const signedInId = (req: { user?: unknown }): number =>
      (req.user as { id: number }).id;

    // Read rather than cached: `sdk.settings.own` is a live view, so a change the
    // operator makes on the settings page takes effect on the next request without
    // a restart. Compared against `true` so a value of some other shape — which
    // the host's validation should already have refused — reads as off.
    const autoApproveWhenUnavailable = (): boolean =>
      sdk.settings.own[SETTING_KEY] === true;

    /** Whether the given variant of the media is available to watch right now. */
    const isAvailable = (
      media: { status: number; status4k: number },
      is4k: boolean
    ): boolean =>
      (
        [MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE] as number[]
      ).includes(is4k ? media.status4k : media.status);

    /**
     * A human-readable cause for a `failed` notification.
     *
     * `NoServarrServerError` is matched on its `arrName` property rather than with
     * `instanceof`, because the class lives in `@server/lib/mediaRemoval` and an
     * extension cannot import it. The distinction matters enough to surface: no
     * configured server is the operator's problem and retrying will not help,
     * where a failed arr call might succeed on a second attempt.
     */
    const describeFailure = (error: unknown): string => {
      const arrName = (error as { arrName?: unknown }).arrName;

      if (typeof arrName === 'string') {
        return `No ${arrName} server is configured, so there is nowhere to delete this from. An administrator needs to configure one; retrying will not help.`;
      }

      return `The Radarr/Sonarr call failed and the media was left as it was: ${
        error instanceof Error ? error.message : String(error)
      }`;
    };

    const notifyRow = async (
      key: 'pending' | 'approved' | 'declined' | 'auto_approved' | 'failed',
      row: RemovalRequest,
      message: string
    ): Promise<void> => {
      const requester = await sdk.users.get(row.requestedById);

      await sdk.notify.send(key, {
        subject: `${row.mediaType === 'movie' ? 'Movie' : 'Series'} removal request #${row.id}`,
        message,
        // Present so the requester hears about their own request, not just
        // admins. Delivery still depends on them holding a subscription to
        // `media-removal:<key>` and having the extension sentinel enabled for an
        // agent; the host resolves both.
        ...(requester ? { notifyUser: requester } : {}),
        extra: [
          { name: 'Application', value: sdk.settings.main.applicationTitle },
          { name: 'Media ID', value: String(row.mediaId) },
          ...(row.is4k ? [{ name: 'Variant', value: '4K' }] : []),
        ],
      });
    };

    /**
     * A row as the panel receives it: the stored columns plus the `tmdbId` of its
     * media.
     *
     * The column is `mediaId`, a core `Media` row id, because that is what
     * `sdk.media.remove` takes and what makes the row meaningful to *this*
     * extension. But a panel showing a poster and a title needs a **tmdbId** —
     * that is the id core's own `GET movie/:tmdbId` and `GET tv/:tmdbId` are keyed
     * on, which is where a browser gets metadata from. So it is resolved here
     * rather than stored: a denormalized copy could go stale, and the panel would
     * otherwise need a second round trip per row just to translate an id.
     *
     * Resolved in one pass over the distinct media ids, not per row, since a page
     * commonly holds the 4K and non-4K variants of the same title. A row whose
     * media has since vanished gets `tmdbId: null` and the panel says so — better
     * than dropping the row, which is the only record that a deletion happened.
     */
    const serialize = async (rows: RemovalRequest[]) => {
      const tmdbIds = new Map<number, number | null>();

      await Promise.all(
        [...new Set(rows.map((row) => row.mediaId))].map(async (mediaId) => {
          const media = await sdk.media.get(mediaId);
          tmdbIds.set(mediaId, media ? media.tmdbId : null);
        })
      );

      return rows.map((row) => ({
        ...row,
        tmdbId: tmdbIds.get(row.mediaId) ?? null,
      }));
    };

    /** {@link serialize} for a single row. */
    const serializeOne = async (row: RemovalRequest) =>
      (await serialize([row]))[0];

    /**
     * Performs the removal for a row that has just become APPROVED, and settles
     * its status.
     *
     * The one place `sdk.media.remove` is called, reached from both approval
     * paths — auto-approval at insert and the approve route — so that "approved"
     * means the same thing however it was reached.
     *
     * A failure is caught rather than propagated. The row has already been saved
     * as APPROVED at this point, so letting the error escape would leave a request
     * that claims to be approved with no record of why nothing happened; instead
     * the row is moved to FAILED, which is both retryable (see
     * `BLOCKING_STATUSES`) and visible in the panel. Core saves the `Media` row
     * only after the arr call returns, so a failure here leaves the media exactly
     * as it was — never half-removed.
     */
    const performRemoval = async (
      row: RemovalRequest
    ): Promise<RemovalRequest> => {
      try {
        await sdk.media.remove(row.mediaId, row.is4k);

        row.status = RemovalRequestStatus.COMPLETED;
        row.updatedAt = new Date();
        const saved = await requests().save(row);

        sdk.logger.info('Removal request completed', {
          removalRequestId: saved.id,
          mediaId: saved.mediaId,
          is4k: saved.is4k,
        });

        await notifyRow(
          'approved',
          saved,
          'The removal was approved and the media has been deleted.'
        );

        return saved;
      } catch (e) {
        row.status = RemovalRequestStatus.FAILED;
        row.updatedAt = new Date();
        const saved = await requests().save(row);

        sdk.logger.error('Removal request failed', {
          removalRequestId: saved.id,
          mediaId: saved.mediaId,
          is4k: saved.is4k,
          errorMessage: e instanceof Error ? e.message : String(e),
        });

        await notifyRow('failed', saved, describeFailure(e));

        return saved;
      }
    };

    /** Whether `userId` may act on other people's rows. */
    const canManage = (userId: number): Promise<boolean> =>
      sdk.users.hasPermission(userId, 'manage');

    // #region routes

    /**
     * Opens a removal request.
     *
     * Every rejection below is a state the panel cannot rule out on its own — the
     * media may have been removed, or already have a request open, by the time a
     * user clicks — so they are all answered as ordinary responses rather than
     * treated as client bugs.
     */
    sdk.router.post(
      '/requests',
      { permission: 'request', body: createBody },
      async (req, res) => {
        const userId = signedInId(req);
        const is4k = req.body.is4k ?? false;
        const media = await sdk.media.get(req.body.mediaId);

        if (!media) {
          res.status(404).json({ message: 'That media does not exist.' });
          return;
        }

        const variantStatus = is4k ? media.status4k : media.status;

        if (variantStatus === MediaStatus.DELETED) {
          res
            .status(400)
            .json({ message: 'This media has already been removed.' });
          return;
        }

        if (variantStatus === MediaStatus.UNKNOWN) {
          // UNKNOWN means core has never tracked this variant — for a 4K request
          // on a title only ever requested in HD, there is nothing on any server
          // to delete, and approving it would call Radarr for a movie it does not
          // have.
          res.status(400).json({
            message: `Seerr is not tracking the ${is4k ? '4K ' : ''}version of this media, so there is nothing to remove.`,
          });
          return;
        }

        // Checked for *every* caller, including one who holds `manage`. The rule is
        // "you may ask for removal of what you requested", and an approver is not
        // exempt from it — they have a separate power, which is to approve, and
        // they exercise it on the review queue rather than by opening a request
        // that skips it. A declined request does not count: it never resulted in
        // anything being added.
        const owned = await sdk.requests.list({
          userId,
          mediaId: media.id,
          take: MAX_PAGE_SIZE,
        });

        if (
          !owned.some(
            (request) =>
              request.is4k === is4k && request.status !== CORE_REQUEST_DECLINED
          )
        ) {
          res.status(403).json({
            message:
              'You can only request removal of media you requested yourself.',
          });
          return;
        }

        const duplicate = await requests().findOne({
          where: BLOCKING_STATUSES.map((status) => ({
            mediaId: media.id,
            is4k,
            status,
          })),
        });

        if (duplicate) {
          res.status(409).json({
            message: 'A removal request for this media is already open.',
          });
          return;
        }

        // The one and only way a request skips review: the *operator* opted in on
        // the settings page, and nothing is available yet, so the deletion destroys
        // nothing a user would miss. Available media always needs approval,
        // whatever the setting says — that asymmetry is the whole point of the
        // setting being conservative.
        //
        // Notably absent: holding `manage` no longer auto-approves your own
        // request. Requesting and approving are two different acts, and collapsing
        // them for approvers meant an admin's removal never appeared in the queue
        // that is supposed to be the record of what was deleted and who decided.
        // An approver asks like everyone else, then approves it from the queue —
        // one extra click, and an audit trail that has no holes in it.
        //
        // Evaluated before the insert rather than after, so the row is never
        // briefly PENDING and the notification reads as automatic. This mirrors
        // what the core draft achieved with an `@AfterInsert` hook.
        const autoApprove =
          autoApproveWhenUnavailable() && !isAvailable(media, is4k);

        const now = new Date();
        let row = await requests().save(
          new RemovalRequest({
            status: autoApprove
              ? RemovalRequestStatus.APPROVED
              : RemovalRequestStatus.PENDING,
            mediaId: media.id,
            is4k,
            mediaType: media.mediaType,
            requestedById: userId,
            // Always null on insert now. The only auto-approval left is
            // setting-driven, which had no decision-maker — naming the requester
            // there would misreport who authorized a deletion. A row gets a
            // `modifiedById` when a person decides it, on the status route.
            modifiedById: null,
            createdAt: now,
            updatedAt: now,
          })
        );

        sdk.logger.info('Removal request created', {
          removalRequestId: row.id,
          mediaId: media.id,
          is4k,
          autoApprove,
        });

        if (autoApprove) {
          // `auto_approved` rather than `pending`: nobody is being asked for
          // anything, and a "needs approval" notification for a request that is
          // already approved would send an approver to an empty queue.
          await notifyRow(
            'auto_approved',
            row,
            'The removal was approved automatically and is being carried out.'
          );
          row = await performRemoval(row);
        } else {
          await notifyRow(
            'pending',
            row,
            'A removal request is waiting for approval.'
          );
        }

        res.status(201).json(await serializeOne(row));
      }
    );

    /**
     * The panel's main read.
     *
     * Scoped to the caller's own rows unless they hold `manage` — checked here
     * rather than declared on the route, because which rows are visible depends on
     * a permission the route gate does not require.
     */
    sdk.router.get('/requests', { permission: 'request' }, async (req, res) => {
      const parsed = listQuery.safeParse(req.query);

      if (!parsed.success) {
        res.status(400).json({ message: 'Invalid query.' });
        return;
      }

      const userId = signedInId(req);
      // Capped rather than rejected: a panel asking for more than a page is not
      // misbehaving, and a 400 here would be a worse answer than a smaller page.
      const take = Math.min(
        parsed.data.take ?? DEFAULT_PAGE_SIZE,
        MAX_PAGE_SIZE
      );
      const skip = parsed.data.skip ?? 0;

      const [results, total] = await requests().findAndCount({
        where: (await canManage(userId)) ? {} : { requestedById: userId },
        order: { id: 'DESC' },
        take,
        skip,
      });

      res.status(200).json({
        pageInfo: {
          pages: Math.ceil(total / take),
          pageSize: take,
          results: total,
          page: Math.floor(skip / take) + 1,
        },
        results: await serialize(results),
      });
    });

    sdk.router.get(
      '/requests/:id',
      { permission: 'request' },
      async (req, res) => {
        const parsed = idParams.safeParse(req.params);

        if (!parsed.success) {
          res.status(404).json({ message: 'Removal request not found.' });
          return;
        }

        const row = await requests().findOne({ where: { id: parsed.data.id } });

        if (!row) {
          res.status(404).json({ message: 'Removal request not found.' });
          return;
        }

        const userId = signedInId(req);

        if (row.requestedById !== userId && !(await canManage(userId))) {
          res.status(403).json({
            message: 'You cannot view this removal request.',
          });
          return;
        }

        res.status(200).json(await serializeOne(row));
      }
    );

    /**
     * Approves, declines, or returns a request to pending.
     *
     * Approving here is what triggers the removal. In the core draft that
     * indirection ran through a TypeORM subscriber watching for the status
     * transition; an extension does it inline, which is both fewer moving parts
     * and the only way to answer the request with the *settled* status — a caller
     * gets COMPLETED or FAILED, not APPROVED and a promise.
     */
    sdk.router.post(
      '/requests/:id/:status',
      { permission: 'manage' },
      async (req, res) => {
        const parsed = idParams.safeParse(req.params);
        const requested = (req.params as { status?: string }).status ?? '';
        const status = STATUS_TRANSITIONS[requested];

        // Resolved before the row is read, so an unknown status cannot write
        // anything at all.
        if (!status) {
          res.status(400).json({
            message: `Unknown removal request status: ${requested}`,
          });
          return;
        }

        if (!parsed.success) {
          res.status(404).json({ message: 'Removal request not found.' });
          return;
        }

        const row = await requests().findOne({ where: { id: parsed.data.id } });

        if (!row) {
          res.status(404).json({ message: 'Removal request not found.' });
          return;
        }

        // Whether the removal has already been attempted for this row, which is
        // *not* the same question as "was it APPROVED?": a successful removal
        // settles the row to COMPLETED, so an approve-twice would see a row that
        // is not APPROVED and delete again — against media core has already
        // flagged DELETED, where the arr's 404 is swallowed and the second
        // deletion is therefore silent. FAILED is deliberately absent, so a
        // removal that failed can be retried by approving again.
        const alreadyCarriedOut =
          row.status === RemovalRequestStatus.APPROVED ||
          row.status === RemovalRequestStatus.COMPLETED;

        // Answered as a no-op rather than a conflict: approving something already
        // approved is what a stale panel does, and the caller's intent is already
        // satisfied. Returned unmodified so the response carries the settled
        // status — writing APPROVED back over COMPLETED would lose the record that
        // the deletion actually happened.
        if (status === RemovalRequestStatus.APPROVED && alreadyCarriedOut) {
          res.status(200).json(await serializeOne(row));
          return;
        }

        row.status = status;
        row.modifiedById = signedInId(req);
        row.updatedAt = new Date();
        let saved = await requests().save(row);

        if (status === RemovalRequestStatus.APPROVED) {
          saved = await performRemoval(saved);
        } else if (status === RemovalRequestStatus.DECLINED) {
          await notifyRow(
            'declined',
            saved,
            'The removal request was declined.'
          );
        }

        res.status(200).json(await serializeOne(saved));
      }
    );

    /**
     * Withdraws a request.
     *
     * Gated on `request` rather than `manage`, because the common case is a user
     * changing their mind — but only while it is still PENDING. Once it is
     * approved the files are already gone, and deleting the row would erase the
     * only record that a deletion happened, so from there it takes `manage`.
     */
    sdk.router.delete(
      '/requests/:id',
      { permission: 'request' },
      async (req, res) => {
        const parsed = idParams.safeParse(req.params);

        if (!parsed.success) {
          res.status(404).json({ message: 'Removal request not found.' });
          return;
        }

        const row = await requests().findOne({ where: { id: parsed.data.id } });

        if (!row) {
          res.status(404).json({ message: 'Removal request not found.' });
          return;
        }

        const userId = signedInId(req);
        const isWithdrawableByOwner =
          row.requestedById === userId &&
          row.status === RemovalRequestStatus.PENDING;

        if (!isWithdrawableByOwner && !(await canManage(userId))) {
          res.status(403).json({
            message: 'You cannot withdraw this removal request.',
          });
          return;
        }

        await requests().remove(row);

        res.status(204).send();
      }
    );

    /**
     * What the caller may ask to have removed: their own core media requests, one
     * entry per removable variant.
     *
     * This exists because the panel used to ask for a numeric media id in a text
     * box. Nobody knows their media ids — and worse, freeform entry made the
     * jarring case the *normal* one: every id a user could type that was not
     * theirs came back 403, so the control's default behaviour was to be refused.
     * Jointly, "you may only unrequest what you requested" is a rule the server
     * can simply *enumerate*, so the panel offers a list instead of a guess.
     *
     * Deliberately jointly scoped and unpaged. It is exactly the caller's own
     * requests, which core already caps per user, and the panel needs the whole set
     * to populate a picker rather than a scrolling page.
     *
     * Not gated on `manage`: an approver reads this for *their own* requests too,
     * because they now ask like everyone else.
     */
    sdk.router.get(
      '/removable',
      { permission: 'request' },
      async (req, res) => {
        const userId = signedInId(req);

        const owned = await sdk.requests.list({
          userId,
          take: MAX_PAGE_SIZE,
        });

        // Every removal request of the caller's that is still in the way, read once
        // rather than per candidate: this is the same rule the create route
        // enforces, surfaced early so a jointly-blocked variant is shown as
        // already-requested instead of failing on click.
        const [open] = await requests().findAndCount({
          where: BLOCKING_STATUSES.map((status) => ({
            requestedById: userId,
            status,
          })),
        });
        const alreadyOpen = new Set(
          open.map((row) => `${row.mediaId}:${row.is4k}`)
        );

        const results = owned
          .filter((request) => request.status !== CORE_REQUEST_DECLINED)
          .map((request) => ({
            mediaId: request.media.id,
            is4k: request.is4k,
            mediaType: request.type,
            tmdbId: request.media.tmdbId,
            // Enough for the panel to render each row's state without repeating
            // core's status numbering or this extension's blocking rule.
            available: isAvailable(request.media, request.is4k),
            removed:
              (request.is4k ? request.media.status4k : request.media.status) ===
              MediaStatus.DELETED,
            tracked:
              (request.is4k ? request.media.status4k : request.media.status) !==
              MediaStatus.UNKNOWN,
            removalRequested: alreadyOpen.has(
              `${request.media.id}:${request.is4k}`
            ),
          }))
          // One core request per variant is the common case, but a title requested
          // twice would otherwise appear twice in the picker.
          .filter(
            (entry, index, all) =>
              all.findIndex(
                (other) =>
                  other.mediaId === entry.mediaId && other.is4k === entry.is4k
              ) === index
          );

        res.status(200).json({ results });
      }
    );

    // No `GET`/`POST /settings` any more. The auto-approval switch is a declared
    // setting the host renders at `/settings/extensions/media-removal`, so serving
    // it from here would be a second, weaker-gated door to the same operator
    // decision — and a writable one, which is precisely what moving it out of kv
    // was for. See `SETTING_KEY`.

    // #endregion
  },
});
