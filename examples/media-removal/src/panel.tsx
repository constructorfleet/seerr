/**
 * The Removal Requests panel.
 *
 * A panel is a pre-built **ESM** bundle the host `import()`s at runtime, so two
 * things about this file are not negotiable:
 *
 * - **It default-exports a component taking a single `sdk` prop.** The host reads
 *   `mod.default` and renders `<PanelComponent sdk={sdk} />`; anything else
 *   surfaces as "The panel bundle has no default-exported component."
 * - **Its only bare imports are ones the host's import map provides** — `react`,
 *   `react/jsx-runtime`, `react-intl`, `swr`, `@seerr/extension-ui`, listed in
 *   `server/lib/extensions/sharedModuleSpecifiers.ts`. An unmapped specifier does
 *   not fail loudly; it resolves to a *second copy* of the package, which renders
 *   correctly and then throws on the first hook. Note there is no `axios` entry —
 *   which is why the SDK hands over a pre-scoped `api` instance instead, and why
 *   anything axios-shaped must arrive through `import type`, which emits nothing.
 *
 * `@seerr/extension-ui` is the host's own components, published under a package
 * name. Preferring them to hand-written markup is not only about consistency: a
 * panel is pre-built, so the host's Tailwind build never sees its class names and
 * emits no CSS for them. So every interactive control here is a host component —
 * `Button`, `Badge`, `Tooltip`, `CachedImage` — whose styles are compiled because
 * they live in host source.
 *
 * The layout classes that remain are a real hazard and worth understanding before
 * editing any of them. They work only because host source happens to use the same
 * ones; reach for one it does not and the class does not exist, so it renders as
 * nothing with no error in the console and no line in the server log. Every class
 * below was checked against the host's built stylesheet. `gap-4` is there because
 * host source uses it — `gap-7` is not. If you add one, verify it the same way.
 * See `server/lib/extensions/uiComponents.ts`.
 *
 * It cannot import from `@app/*`, and it cannot import from this extension's own
 * `src/entity` or `src/index.ts` either: those are CommonJS TypeORM source built
 * by the other tsconfig. Anything shared with the server half is therefore
 * restated here, which is why the status numbering appears twice in one
 * extension.
 *
 * ## One screen, two audiences, no operator controls
 *
 * The panel is gated on `request`, the lower of the extension's two permissions,
 * so a user who does not hold it never sees it in the sidebar at all. A holder
 * sees their own rows and a picker over their own core requests; asking for a
 * removal only ever marks it for review. A holder of `manage` additionally sees
 * everyone's rows and the approve/decline controls — the review queue.
 *
 * What is deliberately *not* here is the auto-approval switch. It is a declared
 * setting the host renders at `/settings/extensions/media-removal` behind core's
 * `ADMIN` gate. A control whose effect is deleting files without review does not
 * belong on the screen a requester uses, gated on an extension permission; see
 * `SETTING_KEY` in `index.ts`.
 *
 * ## It draws core's `RequestCard`, and the server does the work
 *
 * Cards are posters, titles and years — because a removal request *is* a
 * request, and a screen that lists media by numeric id while the page next to it
 * lists the same media by poster is not a different design, it is an unfinished
 * one.
 *
 * The shape is core's `RequestCard` (the card Discover's "Recent Requests" row
 * and the user profile draw), not `RequestItem` (the full-width row on
 * `/requests`). Two consequences worth naming, since neither is arbitrary:
 *
 * - **The card is fixed-width by design** — `w-72 sm:w-96` — because core sizes
 *   it for a horizontal slider. In a panel there is no slider, so they are laid
 *   out as a wrapping flex row. Stretching them to full width instead would mean
 *   restating the card's internals, which is the copy this file exists to avoid.
 * - **A card is smaller than a row**, so the three-column field list does not
 *   fit. Only status and the requester survive as fields; "modified by" moves into
 *   the status line's tooltip, and the long failure explanation becomes the retry
 *   button's tooltip rather than a paragraph.
 *
 * What did *not* move into a tooltip is the deletion confirmation, and the reason
 * generalizes past this file: a tooltip needs a hover, so it never opens on a
 * touch device. Reference detail can afford that; the sentence naming the files a
 * tap is about to delete cannot.
 *
 * None of that metadata is fetched here. Every route this panel calls returns each
 * row already decorated: a `media` object with `title`, `year`, `posterUrl` and
 * `backdropUrl`, and `requestedBy`/`modifiedBy` objects with a display name and an
 * avatar. The extension's server half builds them with `sdk.media.getDetails` and
 * `sdk.users.get`.
 *
 * An earlier version of this file did it the other way round: the row carried a
 * bare `tmdbId`, and the panel called core's `GET movie/:tmdbId` and `GET user/:id`
 * through a `sdk.coreApi` instance, then applied the operator's `cacheImages`
 * rewriting itself. It worked, and it was still wrong — **an extension is a backend
 * that may optionally have a frontend.** Doing presentation assembly in the panel
 * means an extension with no UI (one that emails a weekly digest, say) gets
 * nothing, every panel carries its own copy of the TMDB path conventions and the
 * proxy rule, and the panel ends up pinned to core's route shapes, which are not
 * this project's stable API.
 *
 * So `posterUrl` arrives as a string this file hands to `CachedImage`. Note that
 * an earlier version of this comment claimed `CachedImage` was the one host
 * component a panel could not reuse, being `@app/*` source and a Next `<Image>`;
 * `@seerr/extension-ui` publishes it, and it works here because a panel renders
 * inside the host's provider tree, which is where it reads `cacheImages` from.
 *
 * Passing it `type="tmdb"` would be wrong, though: that variant rewrites a
 * `https://image.tmdb.org/` prefix to `/imageproxy/tmdb/`, and the server has
 * already applied the operator's setting. `type="avatar"` passes the URL through
 * untouched, which is what a pre-resolved URL needs — so a proxied URL is not
 * proxied twice. This is also why there is no `sdk.imageUrl`: the rewriting
 * belongs on the server, and it is already done by the time a card sees it.
 *
 * ## The picker, and what it replaced
 *
 * This used to be a text box asking for a numeric media id. That was bad in a way
 * worth recording: nobody knows their media ids, and since the server only permits
 * removal of media you requested, *every* id a user could successfully guess was
 * already known to the server. So the rule is enumerated instead — `GET /removable`
 * returns the caller's own requests, and each is offered with its poster.
 *
 * What is still missing is a control on the media detail page itself, beside
 * core's request button. A panel cannot edit `RequestButton`, so removal starts
 * here rather than from the title you are looking at. Closing that needs a core
 * extension point for media-page actions — follow-up work on the extension system
 * rather than something this panel can fix.
 */
import type { ExtensionPanelSdk } from '@seerr/extension-ui';
import { Badge, Button, CachedImage, Tooltip } from '@seerr/extension-ui';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { FormattedRelativeTime } from 'react-intl';

/**
 * The panel SDK, imported from `@seerr/extension-ui` rather than re-declared.
 *
 * This used to be a hand-written partial interface, on the reasoning that the
 * type was small enough that structural agreement beat shipping the host's
 * `.d.ts`. `@seerr/extension-ui` now ships exactly that `.d.ts` — generated from
 * host source, so there is no copy to drift — which makes a local restatement
 * pure liability: a member the host adds stays invisible here, and one it renames
 * breaks at runtime instead of at build.
 *
 * A type-only import, so it emits nothing and the specifier never reaches the
 * browser. The *value* import below does reach it, and resolves through the
 * host's import map to the host's own components.
 */
type PanelSdk = ExtensionPanelSdk;

/**
 * Core `MediaRequestStatus`'s numbering, restated a second time in this
 * extension. `entity/RemovalRequest.ts` argues for the numbers matching core's;
 * what it cannot do is share them with this file.
 */
const RemovalRequestStatus = {
  PENDING: 1,
  APPROVED: 2,
  DECLINED: 3,
  FAILED: 4,
  COMPLETED: 5,
} as const;

/**
 * What each status means to a reader, rather than what it is called in the
 * database.
 *
 * APPROVED is the one worth explaining. Approval performs the removal
 * synchronously and settles the row to COMPLETED or FAILED before answering, so a
 * row is only ever *observed* as APPROVED when the process died between the status
 * write and the arr call finishing. "Removing" is the truthful label for that, and
 * "Approved" would suggest a decision that is finished when it is not.
 */
const STATUS_LABELS: Record<number, string> = {
  [RemovalRequestStatus.PENDING]: 'Awaiting review',
  [RemovalRequestStatus.APPROVED]: 'Removing',
  [RemovalRequestStatus.DECLINED]: 'Declined',
  [RemovalRequestStatus.FAILED]: 'Failed',
  [RemovalRequestStatus.COMPLETED]: 'Removed',
};

/**
 * Which `Badge` variant each status draws as.
 *
 * This used to be five hand-written class strings approximating core's `Badge`,
 * because a panel could not import the component. It can now, so these are the
 * variant *names* and the colours come from core — which also means a Seerr
 * retheme reaches this panel with no release here.
 *
 * `warning` for pending, `danger` for declined and failed, `success` for a
 * completed removal, and `primary` for the in-flight APPROVED state.
 */
const STATUS_BADGE: Record<
  number,
  'warning' | 'danger' | 'success' | 'primary'
> = {
  [RemovalRequestStatus.PENDING]: 'warning',
  [RemovalRequestStatus.APPROVED]: 'primary',
  [RemovalRequestStatus.DECLINED]: 'danger',
  [RemovalRequestStatus.FAILED]: 'danger',
  [RemovalRequestStatus.COMPLETED]: 'success',
};

/** One `ext_media-removal_request` row, as it arrives over the wire. */
interface RemovalRequestRow {
  id: number;
  status: number;
  mediaId: number;
  /**
   * Server-resolved metadata, `null` when the media row is gone from Seerr or TMDB
   * would not answer. The column stores `mediaId`, because that is what a removal
   * takes; this is what a person recognizes.
   */
  media: MediaDetails | null;
  is4k: boolean;
  mediaType: 'movie' | 'tv';
  requestedById: number;
  modifiedById?: number | null;
  /** The same, for the people on the row. `null` for a deleted account. */
  requestedBy: RowUser | null;
  modifiedBy: RowUser | null;
  /** `Date` columns, so they arrive JSON-serialized as ISO strings. */
  createdAt: string;
  updatedAt: string;
}

interface ListResponse {
  pageInfo: { pages: number; pageSize: number; results: number; page: number };
  results: RemovalRequestRow[];
}

/** One entry from `GET /removable`: a variant the caller requested. */
interface RemovableEntry {
  mediaId: number;
  is4k: boolean;
  mediaType: 'movie' | 'tv';
  media: MediaDetails | null;
  available: boolean;
  removed: boolean;
  tracked: boolean;
  removalRequested: boolean;
}

/**
 * `ExtensionMediaDetails`, as the SDK defines it and the extension's routes embed
 * it. Restated structurally rather than imported: `@seerr/extension-sdk` is the
 * server half's dependency and this file is built by the other tsconfig.
 *
 * One name per concept, whichever media type it is — no `title`-versus-`name`
 * branching, which is the point of the host resolving it.
 */
interface MediaDetails {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  title: string;
  year: number | null;
  overview: string;
  /** Already honours the operator's `cacheImages` setting: usable as an `<img src>`. */
  posterUrl: string | null;
  backdropUrl: string | null;
}

/** Who a row names, as the extension's routes serve them. */
interface RowUser {
  id: number;
  displayName: string;
  /** A host-relative or absolute URL, whichever core stores. */
  avatar: string;
}

/** Matches `DEFAULT_PAGE_SIZE` in `index.ts`. The server caps `take` at 100. */
const PAGE_SIZE = 20;

/** The `<option>` value for one entry, and the way back to its fields. */
const entryKey = (entry: RemovableEntry): string =>
  `${entry.mediaId}:${entry.is4k ? '4k' : 'hd'}`;

/** Core's own placeholder, served by the host, so a missing poster still fits. */
const POSTER_FALLBACK = '/images/seerr_poster_not_found.png';

const posterUrl = (media: MediaDetails | null): string =>
  media?.posterUrl ?? POSTER_FALLBACK;

/** What to call a row when the media is gone and there is no title to use. */
const fallbackLabel = (mediaType: 'movie' | 'tv', mediaId: number): string =>
  `${mediaType === 'movie' ? 'Movie' : 'Series'} #${mediaId}`;

const mediaHref = (media: MediaDetails): string =>
  `/${media.mediaType === 'movie' ? 'movie' : 'tv'}/${media.tmdbId}`;

/**
 * Seconds from now, as `FormattedRelativeTime` wants it.
 *
 * Negative for the past, which every date this panel shows is. Matches how core's
 * `RequestItem` computes the same thing, so "29 seconds ago" reads identically on
 * both screens.
 */
const secondsFromNow = (iso: string): number =>
  Math.floor((new Date(iso).getTime() - Date.now()) / 1000);

/**
 * The server's own message, or a fallback.
 *
 * Every rejection these routes issue is written for a person — "Seerr is not
 * tracking the 4K version of this media", "A removal request for this media is
 * already open" — and each names a state the panel could not have ruled out
 * before asking. Replacing them with one generic failure would discard the only
 * useful half of the response. Dug out structurally rather than with
 * `axios.isAxiosError`, because that is a value import and `axios` is not a shared
 * specifier: the shape is all this file has, and all it needs.
 */
const messageOf = (error: unknown, fallback: string): string => {
  const data = (error as { response?: { data?: unknown } }).response?.data;
  const message = (data as { message?: unknown } | undefined)?.message;

  return typeof message === 'string' && message ? message : fallback;
};

/**
 * The status pill — core's `Badge`, not an imitation of it.
 *
 * An unrecognized status falls through to the `default` variant rather than
 * throwing: the number arrives over the wire, and a host running a newer copy of
 * this extension than the panel bundle can send one this file has no label for.
 */
const StatusBadge = ({ status }: { status: number }) => (
  <Badge badgeType={STATUS_BADGE[status] ?? 'default'}>
    {STATUS_LABELS[status] ?? `Status ${status}`}
  </Badge>
);

/**
 * A user's avatar and name, or a plain id when the account is gone.
 *
 * The user arrives on the row, resolved by the extension's own route through
 * `sdk.users.get` — a panel does not read core's user API. A `null` falls back to
 * the id rather than hiding the line: who asked for a deletion is the point of it.
 */
const UserLabel = ({
  sdk,
  userId,
  user,
}: {
  sdk: PanelSdk;
  userId: number;
  user: RowUser | null;
}) => {
  if (userId === sdk.user.id) {
    return <span className="font-semibold text-gray-200">you</span>;
  }

  if (!user) {
    return <span className="text-gray-300">user #{userId}</span>;
  }

  return (
    <a href={`/users/${user.id}`} className="group flex items-center">
      {/* `avatar-sm` and the `CachedImage type="avatar"` pairing are exactly what
          core's own `RequestCard` does for this line. The avatar variant passes
          the URL through untouched, which is right for whatever core stored. */}
      <span className="avatar-sm">
        <CachedImage
          type="avatar"
          src={user.avatar}
          alt=""
          className="avatar-sm object-cover"
          width={20}
          height={20}
        />
      </span>
      <span className="truncate font-semibold group-hover:text-white group-hover:underline">
        {user.displayName}
      </span>
    </a>
  );
};

/**
 * The card chrome core's `RequestCard` draws, as a shell both lists share.
 *
 * Two lists on this screen are lists of media — the requests you *could* ask to
 * have removed, and the removal requests that exist — and neither is a form
 * control. Drawing them the same way is the point: the classes here are copied
 * from `src/components/RequestCard`, which is what the requests page looks like,
 * and every one of them is verified present in the host stylesheet (a panel's
 * class names are never seen by Tailwind's JIT, so an unemitted class renders as
 * nothing with no error anywhere).
 *
 * `children` is the left column; the poster and backdrop are handled here so the
 * two call sites cannot drift apart on them.
 */
const MediaCard = ({
  media,
  is4k,
  fallbackTitle,
  children,
}: {
  media: MediaDetails | null;
  is4k: boolean;
  /** Shown when the server had no metadata to resolve. */
  fallbackTitle: string;
  children: ReactNode;
}) => (
  <div className="relative flex w-72 overflow-hidden rounded-xl bg-gray-800 bg-cover bg-center p-4 text-gray-400 shadow ring-1 ring-gray-700 sm:w-96">
    {media?.backdropUrl && (
      <div className="absolute inset-0 z-0">
        <CachedImage
          type="avatar"
          alt=""
          src={media.backdropUrl}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          fill
        />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              'linear-gradient(135deg, rgba(17, 24, 39, 0.47) 0%, rgba(17, 24, 39, 1) 75%)',
          }}
        />
      </div>
    )}

    <div className="relative z-10 flex min-w-0 flex-1 flex-col pr-4">
      {media?.year && (
        <div className="hidden text-xs font-medium text-white sm:flex">
          {media.year}
        </div>
      )}

      {media ? (
        <a
          href={mediaHref(media)}
          className="overflow-hidden overflow-ellipsis whitespace-nowrap text-base font-bold text-white hover:underline sm:text-lg"
        >
          {media.title}
        </a>
      ) : (
        <span className="overflow-hidden overflow-ellipsis whitespace-nowrap text-base font-bold text-white sm:text-lg">
          {fallbackTitle}
        </span>
      )}

      {/* Visible at every width, unlike the seasons row this copies its spacing
          from, which core hides on small screens. 4K and non-4K are separate
          servers and a removal only touches one of them, so which variant a card
          is about is the difference between the right deletion and the wrong
          one. */}
      {is4k && (
        <div className="my-0.5 flex items-center text-sm sm:my-1">
          <Badge badgeType="primary">4K</Badge>
        </div>
      )}

      {children}
    </div>

    {/* The poster, on the right as core draws it. */}
    {media ? (
      <a
        href={mediaHref(media)}
        className="w-20 flex-shrink-0 scale-100 transform-gpu cursor-pointer overflow-hidden rounded-md shadow-sm transition duration-300 hover:scale-105 hover:shadow-md sm:w-28"
      >
        <CachedImage
          type="avatar"
          src={posterUrl(media)}
          alt=""
          sizes="100vw"
          style={{ width: '100%', height: 'auto' }}
          width={600}
          height={900}
        />
      </a>
    ) : (
      <span className="w-20 flex-shrink-0 overflow-hidden rounded-md shadow-sm sm:w-28">
        <CachedImage
          type="avatar"
          src={POSTER_FALLBACK}
          alt=""
          sizes="100vw"
          style={{ width: '100%', height: 'auto' }}
          width={600}
          height={900}
        />
      </span>
    )}
  </div>
);

const RemovalRequestsPanel = ({ sdk }: { sdk: PanelSdk }) => {
  const [data, setData] = useState<ListResponse>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  /** The row an action is in flight for, so only that row's buttons go quiet. */
  const [busyId, setBusyId] = useState<number>();
  /** The row whose approval is waiting on confirmation. */
  const [confirmingId, setConfirmingId] = useState<number>();
  const [removable, setRemovable] = useState<RemovableEntry[]>();
  /**
   * The `entryKey` of the card whose submission is in flight.
   *
   * A key rather than a boolean because every candidate carries its own button:
   * a single flag would grey out all of them for one click.
   */
  const [creatingKey, setCreatingKey] = useState<string>();

  const canManage = sdk.hasPermission('manage');

  const load = useCallback(
    async (requestedPage: number) => {
      setLoading(true);
      setError(undefined);

      try {
        // Relative, because `sdk.api` is already scoped to
        // `/api/v1/ext/media-removal/` — including the CSRF behaviour the
        // non-GET routes below need.
        //
        // No client-side ownership filter: the route already scopes the result to
        // the caller's own rows unless they hold `manage`, and a second copy of
        // that rule here would be a place for the two to disagree.
        const response = await sdk.api.get<ListResponse>('requests', {
          params: { take: PAGE_SIZE, skip: (requestedPage - 1) * PAGE_SIZE },
        });
        setData(response.data);
      } catch (e) {
        setError(messageOf(e, 'Removal requests could not be loaded.'));
      } finally {
        setLoading(false);
      }
    },
    [sdk]
  );

  /**
   * Reloads the picker.
   *
   * Called after a successful create as well as on mount, because opening a
   * request changes an entry's `removalRequested` — leaving the stale list would
   * offer the same variant again and earn a 409.
   */
  const loadRemovable = useCallback(async () => {
    try {
      const response = await sdk.api.get<{ results: RemovableEntry[] }>(
        'removable'
      );
      setRemovable(response.data.results);
    } catch {
      // Left `undefined`, which renders as "could not be read". An empty list
      // would be indistinguishable from "you have requested nothing", which is a
      // different and more discouraging thing to tell someone.
      setRemovable(undefined);
    }
  }, [sdk]);

  // Hand-rolled rather than `useSWR`, and now only by inertia: the original
  // reason was that the host publishes its own SWR *instance*, whose global
  // fetcher is scoped to core's `/api/v1` and not to this extension. `sdk.fetcher`
  // closes that — `useSWR('requests', sdk.fetcher)` would work — but every reload
  // here is an explicit one after a mutation, which is what these loaders already
  // express.
  useEffect(() => {
    void load(page);
  }, [load, page]);

  useEffect(() => {
    void loadRemovable();
  }, [loadRemovable]);

  /**
   * Applies a decision and reports whatever the server settled on.
   *
   * The response body is the *settled* row: approving answers COMPLETED when the
   * arr call succeeded and FAILED when it did not, never a bare APPROVED and a
   * promise. So the toast is read off the response instead of assumed, and a
   * failed removal says so at the moment it fails rather than on the next reload
   * — which matters because "approved" would otherwise be shown for a deletion
   * that never happened.
   */
  const decide = async (
    row: RemovalRequestRow,
    status: 'approve' | 'decline'
  ) => {
    setBusyId(row.id);
    setConfirmingId(undefined);

    const label = labelFor(row);

    try {
      const response = await sdk.api.post<RemovalRequestRow>(
        `requests/${row.id}/${status}`
      );
      const settled = response.data;

      if (settled.status === RemovalRequestStatus.FAILED) {
        sdk.notify(
          `The removal of ${label} failed and nothing was deleted. Approving it again retries.`,
          'error'
        );
      } else if (settled.status === RemovalRequestStatus.COMPLETED) {
        sdk.notify(`${label} was removed.`, 'success');
      } else if (settled.status === RemovalRequestStatus.DECLINED) {
        sdk.notify(`The removal of ${label} was declined.`, 'success');
      } else {
        sdk.notify(`Removal request #${settled.id} was updated.`, 'info');
      }

      // Reloaded rather than patched in place. Approving changes core's media
      // state, and re-reading is also how a row someone else has already decided
      // stops being shown with buttons that would now 404. The picker goes too: a
      // decline frees the variant to be asked for again.
      await load(page);
      await loadRemovable();
    } catch (e) {
      sdk.notify(
        messageOf(e, 'That removal request could not be updated.'),
        'error'
      );
    } finally {
      setBusyId(undefined);
    }
  };

  const withdraw = async (row: RemovalRequestRow) => {
    setBusyId(row.id);

    try {
      // 204, so there is no body to read.
      await sdk.api.delete(`requests/${row.id}`);
      sdk.notify(
        `The removal request for ${labelFor(row)} was withdrawn.`,
        'success'
      );
      await load(page);
      await loadRemovable();
    } catch (e) {
      sdk.notify(
        messageOf(e, 'That removal request could not be withdrawn.'),
        'error'
      );
    } finally {
      setBusyId(undefined);
    }
  };

  /**
   * Opens a removal request for one candidate card.
   *
   * Takes the entry rather than reading a selection: the candidates are drawn as
   * cards with their own buttons, so what was clicked is never in doubt and
   * there is nothing to validate before sending. Every rule is still the
   * server's — a card's flags can be stale by the time a click lands, and when
   * they are, its message is shown verbatim.
   */
  const create = async (entry: RemovableEntry) => {
    setCreatingKey(entryKey(entry));

    const label =
      entry.media?.title ?? fallbackLabel(entry.mediaType, entry.mediaId);

    try {
      // Still sent as `mediaId`/`is4k` rather than an opaque key: the create
      // route is the contract, and it re-checks every rule `/removable` applied.
      // A candidate can go stale between the two — someone else opens a request,
      // or the media is removed — and when it does the server's own message is
      // shown verbatim, exactly as before.
      const response = await sdk.api.post<RemovalRequestRow>('requests', {
        mediaId: entry.mediaId,
        is4k: entry.is4k,
      });
      const created = response.data;

      // The 201 carries a settled status: an operator who turned on auto-approval
      // for unavailable media gets a request that has already been carried out by
      // the time it answers, so "waiting for review" would be wrong for it.
      if (created.status === RemovalRequestStatus.PENDING) {
        sdk.notify(
          `The removal of ${label} was submitted and is waiting for an administrator to review it.`,
          'success'
        );
      } else if (created.status === RemovalRequestStatus.FAILED) {
        sdk.notify(
          `The removal of ${label} was approved automatically but failed, so nothing was deleted.`,
          'error'
        );
      } else {
        sdk.notify(
          `${label} was approved for removal automatically and has been deleted.`,
          'success'
        );
      }

      setPage(1);
      await load(1);
      await loadRemovable();
    } catch (e) {
      sdk.notify(
        messageOf(e, 'That removal request could not be opened.'),
        'error'
      );
      // Reloaded on failure too. Most rejections here mean the eligible set has
      // moved since it was read — a duplicate was opened, the media was removed —
      // so leaving the stale card on screen would invite the same failure again.
      await loadRemovable();
    } finally {
      setCreatingKey(undefined);
    }
  };

  /** What to call a row in a sentence: its title, or its ids when there is none. */
  function labelFor(row: RemovalRequestRow): string {
    return row.media?.title ?? fallbackLabel(row.mediaType, row.mediaId);
  }

  const rows = data?.results ?? [];
  const pageInfo = data?.pageInfo;
  const totalPages = Math.max(pageInfo?.pages ?? 1, 1);
  // What is offerable *now*: already-removed and untracked variants would be
  // refused, and one with a request open would 409. Filtered out rather than shown
  // disabled, because each is already accounted for in the list below.
  const offerable = (removable ?? []).filter(
    (entry) => entry.tracked && !entry.removed && !entry.removalRequested
  );

  return (
    <div className="mt-6">
      <div className="mb-6">
        <h3 className="heading">Removal Requests</h3>
        <p className="description">
          {canManage
            ? 'Review requests to delete media. Approving one deletes the files from Radarr or Sonarr and cannot be undone. Your own requests appear here for review like everyone else’s.'
            : 'Ask for media you requested to be deleted. A request is marked for an administrator to review — nothing is deleted until one approves it.'}
        </p>
      </div>

      {/* Not a bordered box around a control: this is a list of media, so it is
          drawn as one — the same cards as the requests page, each with its own
          button. There is nothing to choose and then submit. */}
      <div className="mb-8">
        <h4 className="text-sm font-semibold text-white">Request a removal</h4>
        <p className="mt-1 text-xs text-gray-400">
          These are the requests you have made. Asking for one sends it to an
          administrator to delete; you cannot delete anything yourself.
        </p>

        {removable === undefined ? (
          <p className="mt-3 text-xs text-gray-500">
            Your requests could not be read, so nothing is offered rather than
            an empty list. Reload the panel to try again.
          </p>
        ) : !offerable.length ? (
          <p className="mt-3 text-xs text-gray-500">
            {removable.length
              ? 'Everything you have requested is either already removed or already waiting on a removal request.'
              : 'You have not requested anything, so there is nothing to ask to have removed.'}
          </p>
        ) : (
          <div className="mt-4 flex flex-wrap gap-4">
            {offerable.map((entry) => {
              const key = entryKey(entry);
              const submitting = creatingKey === key;

              return (
                <MediaCard
                  key={key}
                  media={entry.media}
                  is4k={entry.is4k}
                  // The ids, when the server had no metadata to resolve: an
                  // entry stays askable rather than becoming nameless.
                  fallbackTitle={fallbackLabel(entry.mediaType, entry.mediaId)}
                >
                  {/* What the dropdown used to say after "·". Not available yet
                      still gets a card: a request can be withdrawn from the arr
                      queue, and the server decides, not this list. */}
                  <div className="card-field">
                    <span className="card-field-name">
                      {entry.available ? 'Available' : 'Not available yet'}
                    </span>
                  </div>

                  <div className="flex flex-1 items-end space-x-2">
                    <Button
                      buttonType="danger"
                      buttonSize="sm"
                      className="mt-4"
                      disabled={submitting}
                      onClick={() => void create(entry)}
                    >
                      <span>
                        {submitting ? 'Submitting…' : 'Request removal'}
                      </span>
                    </Button>
                  </div>
                </MediaCard>
              );
            })}
          </div>
        )}
      </div>

      {error ? (
        <p className="text-sm text-red-500">{error}</p>
      ) : loading && !data ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : !rows.length ? (
        <p className="text-sm text-gray-400">No removal requests yet.</p>
      ) : (
        // Core sizes `RequestCard` for a horizontal slider, so the cards are
        // fixed-width. There is no slider here, so they wrap.
        <div className="flex flex-wrap gap-4">
          {rows.map((row) => {
            const isOwn = row.requestedById === sdk.user.id;
            const isPending = row.status === RemovalRequestStatus.PENDING;
            const hasFailed = row.status === RemovalRequestStatus.FAILED;
            const busy = busyId === row.id;
            const confirming = confirmingId === row.id;
            // A failed row is the owner's to withdraw as well as an approver's to
            // retry: it blocks them from asking again, and a retry takes `manage`,
            // so without this the only person affected could do nothing about it.
            const ownerCanWithdraw = isOwn && (isPending || hasFailed);
            const showActions =
              (canManage && (isPending || hasFailed)) || ownerCanWithdraw;
            return (
              <MediaCard
                key={row.id}
                media={row.media}
                is4k={row.is4k}
                // Either the media row is gone — deleted from Seerr entirely,
                // not merely removed from an arr — or TMDB would not answer. The
                // request is kept regardless, because it is the record that a
                // removal happened.
                fallbackTitle={`${fallbackLabel(
                  row.mediaType,
                  row.mediaId
                )} (no metadata)`}
              >
                <>
                  <div className="card-field">
                    <UserLabel
                      sdk={sdk}
                      userId={row.requestedById}
                      user={row.requestedBy}
                    />
                  </div>

                  {/* Status, plus the two dates as its tooltip. A card has no
                      room for the row layout's three field columns, and "when,
                      by whom" is reference detail rather than something to
                      scan — so it hovers instead of taking a line. */}
                  <div className="mt-2 flex items-center text-sm sm:mt-1">
                    <span className="mr-2 hidden font-bold sm:block">
                      Status
                    </span>
                    <Tooltip
                      content={
                        <span className="flex items-center">
                          Requested&nbsp;
                          <FormattedRelativeTime
                            value={secondsFromNow(row.createdAt)}
                            updateIntervalInSeconds={1}
                            numeric="auto"
                          />
                          {row.modifiedById != null && (
                            <>
                              &nbsp;· modified&nbsp;
                              <FormattedRelativeTime
                                value={secondsFromNow(row.updatedAt)}
                                updateIntervalInSeconds={1}
                                numeric="auto"
                              />
                              &nbsp;by&nbsp;
                              <UserLabel
                                sdk={sdk}
                                userId={row.modifiedById}
                                user={row.modifiedBy}
                              />
                            </>
                          )}
                        </span>
                      }
                    >
                      {/* `Tooltip` clones its child to attach a ref. `Badge`
                          itself forwards one, but `StatusBadge` is a plain
                          function wrapping it and does not, so the ref needs a
                          real element to land on. */}
                      <span>
                        <StatusBadge status={row.status} />
                      </span>
                    </Tooltip>
                  </div>

                  <div className="flex flex-1 items-end space-x-2">
                    {showActions && (
                      <>
                        {canManage &&
                          (isPending || hasFailed) &&
                          (confirming ? (
                            // A confirm step in the card rather than a
                            // `window.confirm`: this is the only irreversible
                            // action any panel in this repo takes, and the
                            // sentence naming exactly what gets deleted has to be
                            // on screen at the moment the decision is made.
                            //
                            // Deliberately *not* a tooltip, unlike the other long
                            // explanations on this card. A tooltip needs a hover,
                            // so on a touch device it never opens — which would
                            // leave a phone user tapping "Yes, delete" having been
                            // shown nothing about what it deletes. Text this
                            // consequential cannot be behind an interaction that
                            // half the clients cannot perform, so the card grows
                            // instead and the buttons stack under it.
                            <div className="mt-4 flex flex-col space-y-2">
                              {/* `text-red-300`, not the `text-red-400` this used
                                  to say: host source never uses that shade, so
                                  Tailwind never emitted it and this sentence
                                  inherited the card's gray. Verified against the
                                  built stylesheet — the hazard in the header,
                                  caught in this very file. */}
                              <span className="text-xs text-red-300">
                                This deletes the {row.is4k ? '4K ' : ''}files
                                for {labelFor(row)} from{' '}
                                {row.mediaType === 'movie'
                                  ? 'Radarr'
                                  : 'Sonarr'}
                                , and cannot be undone. Continue?
                              </span>
                              <div className="flex space-x-2">
                                <Button
                                  buttonType="danger"
                                  buttonSize="sm"
                                  disabled={busy}
                                  onClick={() => void decide(row, 'approve')}
                                >
                                  <span>
                                    {busy ? 'Removing…' : 'Yes, delete'}
                                  </span>
                                </Button>
                                <Button
                                  buttonType="default"
                                  buttonSize="sm"
                                  disabled={busy}
                                  onClick={() => setConfirmingId(undefined)}
                                >
                                  <span>Cancel</span>
                                </Button>
                              </div>
                            </div>
                          ) : (
                            // A tooltip is fine here, where it would not be on the
                            // confirm step above: this explains why a retry might
                            // not help, and a touch user who never sees it has
                            // still been told by the notification the failure
                            // sent. Nothing irreversible hangs on reading it.
                            <Tooltip
                              content={
                                hasFailed
                                  ? 'Radarr or Sonarr refused this removal and nothing was deleted. Approving it again retries — unless no server is configured for this media, in which case a retry will not help and the notification said so.'
                                  : 'Approve this removal'
                              }
                            >
                              <Button
                                buttonType="success"
                                buttonSize="sm"
                                className="mt-4"
                                disabled={busy}
                                onClick={() => setConfirmingId(row.id)}
                              >
                                <span>{hasFailed ? 'Retry' : 'Approve'}</span>
                              </Button>
                            </Tooltip>
                          ))}

                        {canManage && isPending && !confirming && (
                          <Button
                            buttonType="danger"
                            buttonSize="sm"
                            className="mt-4"
                            disabled={busy}
                            onClick={() => void decide(row, 'decline')}
                          >
                            <span>Decline</span>
                          </Button>
                        )}

                        {/* Offered to the owner while nothing has been deleted —
                            pending, or failed. Once a removal has happened the
                            files are gone and the row is the only record of it,
                            so the server requires `manage` to delete it: a
                            different action from changing your mind, and not
                            offered as one. */}
                        {ownerCanWithdraw && !confirming && (
                          <Button
                            buttonType="default"
                            buttonSize="sm"
                            className="mt-4"
                            disabled={busy}
                            onClick={() => void withdraw(row)}
                          >
                            <span>Withdraw</span>
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </>
              </MediaCard>
            );
          })}
        </div>
      )}

      {pageInfo && pageInfo.results > 0 && (
        <div className="mt-6 flex items-center justify-between text-xs text-gray-500">
          <span>
            Page {pageInfo.page} of {totalPages} · {pageInfo.results} request
            {pageInfo.results === 1 ? '' : 's'}
          </span>
          <div className="flex gap-2">
            <Button
              buttonSize="sm"
              disabled={loading || page <= 1}
              onClick={() => setPage((current) => Math.max(current - 1, 1))}
            >
              <span>Previous</span>
            </Button>
            <Button
              buttonSize="sm"
              disabled={loading || page >= totalPages}
              onClick={() => setPage((current) => current + 1)}
            >
              <span>Next</span>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default RemovalRequestsPanel;
