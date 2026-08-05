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
 *   `react/jsx-runtime`, `react-intl`, `swr`, listed in
 *   `server/lib/extensions/sharedModuleSpecifiers.ts`. An unmapped specifier does
 *   not fail loudly; it resolves to a *second copy* of the package, which renders
 *   correctly and then throws on the first hook. Note there is no `axios` entry —
 *   which is why the SDK hands over pre-scoped `api` and `coreApi` instances
 *   instead, and why `AxiosInstance` below is an `import type`: a type-only import
 *   emits nothing, so the specifier never reaches the browser at all.
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
 * ## It looks like the Requests page, and that took `sdk.coreApi`
 *
 * Rows are posters, titles and years, laid out like `RequestList` — because a
 * removal request *is* a request, and a screen that lists media by numeric id
 * while the page next to it lists the same media by poster is not a different
 * design, it is an unfinished one.
 *
 * That needs metadata the server SDK does not expose. `sdk.media.get` returns core
 * `Media` rows — ids and statuses — and deliberately not TMDB details: an
 * extension that wants a poster wants it in a browser, and proxying tmdb.org
 * through a server capability would make core cache and fetch on an extension's
 * behalf for a purely presentational read. So the panel asks core's own API
 * directly, as the signed-in user, through `sdk.coreApi`: `GET movie/:tmdbId`,
 * `GET tv/:tmdbId` and `GET user/:id` are the same endpoints Seerr's own pages
 * use, all `isAuthenticated()` and no more. The ceiling is what the *user* may
 * read, so this is not a way around the manifest.
 *
 * The one host thing a panel cannot reuse is `CachedImage`: it is `@app/*` source
 * and a Next `<Image>`. So images go through `sdk.imageUrl`, which applies the
 * operator's `cacheImages` rewriting, into a plain `<img>`.
 *
 * Two consequences worth naming. Core's routes are not this project's stable API,
 * so a panel pinned to their shapes is pinned to a Seerr version — fine for
 * presentation, which is all this does; the extension's *logic* runs against its
 * own routes. And metadata is fetched per row, so it arrives after the rows do:
 * every row renders immediately with what the removal row itself carries and fills
 * in the title when it lands, rather than blocking the list on TMDB.
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
import type { AxiosInstance } from 'axios';
import { useCallback, useEffect, useState } from 'react';
import type { IntlShape } from 'react-intl';
import { FormattedRelativeTime } from 'react-intl';

/**
 * The panel SDK, re-declared rather than imported.
 *
 * `@app/components/ExtensionPanel/sdk` is host source, and the type is small
 * enough that structural agreement is cheaper than shipping the host's `.d.ts`.
 * Only the members this panel touches are declared — the object it receives has
 * more.
 */
interface PanelSdk {
  user: { id: number; displayName?: string };
  hasPermission: (permission: string | string[]) => boolean;
  /** Scoped to `/api/v1/ext/media-removal/`: this extension's own routes. */
  api: AxiosInstance;
  /** Scoped to `/api/v1/`: core's read API, as the signed-in user. */
  coreApi: AxiosInstance;
  imageUrl: (src: string, kind: 'tmdb' | 'tvdb' | 'avatar') => string;
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
  intl: IntlShape;
}

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
 * Badge colours matching core's `Badge` variants, since a panel cannot import the
 * component: `warning` for pending, `danger` for declined and failed, `success`
 * for a completed removal.
 */
const STATUS_CLASSES: Record<number, string> = {
  [RemovalRequestStatus.PENDING]:
    'bg-yellow-500 bg-opacity-80 border-yellow-500 text-yellow-100',
  [RemovalRequestStatus.APPROVED]:
    'bg-indigo-500 bg-opacity-80 border-indigo-500 text-indigo-100',
  [RemovalRequestStatus.DECLINED]:
    'bg-red-600 bg-opacity-80 border-red-600 text-red-100',
  [RemovalRequestStatus.FAILED]:
    'bg-red-600 bg-opacity-80 border-red-600 text-red-100',
  [RemovalRequestStatus.COMPLETED]:
    'bg-green-500 bg-opacity-80 border-green-500 text-green-100',
};

/** One `ext_media-removal_request` row, as it arrives over the wire. */
interface RemovalRequestRow {
  id: number;
  status: number;
  mediaId: number;
  /**
   * Resolved by the server from `mediaId`, and `null` when the media row is gone.
   * The column stores `mediaId`, because that is what a removal takes; this is
   * what core's metadata endpoints are keyed on.
   */
  tmdbId: number | null;
  is4k: boolean;
  mediaType: 'movie' | 'tv';
  requestedById: number;
  modifiedById?: number | null;
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
  tmdbId: number;
  available: boolean;
  removed: boolean;
  tracked: boolean;
  removalRequested: boolean;
}

/**
 * The slice of core's `MovieDetails`/`TvDetails` this panel renders.
 *
 * Structural, and deliberately small: these are core's route shapes, not a
 * contract this extension is owed, so the less of them it names the less there is
 * to break. `title`/`releaseDate` are the movie fields, `name`/`firstAirDate` the
 * series ones.
 */
interface MediaDetails {
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  posterPath?: string;
  backdropPath?: string;
}

/** The slice of core's `User` the panel renders beside a decision. */
interface CoreUser {
  id: number;
  displayName: string;
  avatar: string;
}

/** Matches `DEFAULT_PAGE_SIZE` in `index.ts`. The server caps `take` at 100. */
const PAGE_SIZE = 20;

/** The `<option>` value for one entry, and the way back to its fields. */
const entryKey = (entry: RemovableEntry): string =>
  `${entry.mediaId}:${entry.is4k ? '4k' : 'hd'}`;

/** The cache key for one title's metadata: type and tmdbId together. */
const detailsKey = (mediaType: 'movie' | 'tv', tmdbId: number): string =>
  `${mediaType}:${tmdbId}`;

const titleOf = (details: MediaDetails): string =>
  details.title ?? details.name ?? 'Unknown Title';

const yearOf = (details: MediaDetails): string =>
  (details.releaseDate ?? details.firstAirDate ?? '').slice(0, 4);

/** Core's own placeholder, served by the host, so a missing poster still fits. */
const POSTER_FALLBACK = '/images/seerr_poster_not_found.png';

const posterUrl = (sdk: PanelSdk, details?: MediaDetails): string =>
  details?.posterPath
    ? sdk.imageUrl(
        `https://image.tmdb.org/t/p/w600_and_h900_bestv2${details.posterPath}`,
        'tmdb'
      )
    : POSTER_FALLBACK;

const mediaHref = (mediaType: 'movie' | 'tv', tmdbId: number): string =>
  `/${mediaType === 'movie' ? 'movie' : 'tv'}/${tmdbId}`;

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

/** The status pill, shaped like core's `Badge`. */
const StatusBadge = ({ status }: { status: number }) => (
  <span
    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
      STATUS_CLASSES[status] ?? 'border-gray-600 bg-gray-700 text-gray-200'
    }`}
  >
    {STATUS_LABELS[status] ?? `Status ${status}`}
  </span>
);

/**
 * A user's avatar and name, or a plain id while the lookup is in flight.
 *
 * `GET user/:id` is `isAuthenticated()` and redacts anything sensitive for a
 * caller without `MANAGE_USERS`, so a requester reading it sees a display name and
 * an avatar — which is all this renders. A failed lookup falls back to the id
 * rather than hiding the row: who asked for a deletion is the point of the line.
 */
const UserLabel = ({
  sdk,
  userId,
  user,
}: {
  sdk: PanelSdk;
  userId: number;
  user?: CoreUser;
}) => {
  if (userId === sdk.user.id) {
    return <span className="font-semibold text-gray-200">you</span>;
  }

  if (!user) {
    return <span className="text-gray-300">user #{userId}</span>;
  }

  return (
    <a
      href={`/users/${user.id}`}
      className="group inline-flex items-center truncate align-middle"
    >
      {/* A plain `<img>`: `CachedImage` is a Next `<Image>` behind `@app/*` and
          needs the host's build. `sdk.imageUrl` supplies the one thing that would
          otherwise be lost, which is the operator's `cacheImages` rewriting. */}
      <img
        src={sdk.imageUrl(user.avatar, 'avatar')}
        alt=""
        width={20}
        height={20}
        className="mr-1 h-5 w-5 rounded-full object-cover"
      />
      <span className="truncate font-semibold group-hover:text-white group-hover:underline">
        {user.displayName}
      </span>
    </a>
  );
};

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
  const [selected, setSelected] = useState('');
  const [creating, setCreating] = useState(false);
  /**
   * Metadata caches, keyed so a title is fetched once however many rows show it.
   *
   * Filled in after the rows render rather than awaited with them: a page of 20
   * rows is 20 TMDB reads, and holding the whole list back for the slowest of them
   * would make a fast local list feel like a remote one. A row with nothing here
   * yet shows its poster placeholder and no title, then fills in.
   */
  const [details, setDetails] = useState<Record<string, MediaDetails>>({});
  const [users, setUsers] = useState<Record<number, CoreUser>>({});

  const canManage = sdk.hasPermission('manage');

  /**
   * Fetches metadata for titles not already cached.
   *
   * Failures are swallowed per title: a TMDB read that fails leaves the row
   * showing its ids, which is strictly more than the previous version of this
   * panel ever showed, and is not worth an error banner over a list that
   * otherwise works.
   */
  const loadDetails = useCallback(
    async (wanted: { mediaType: 'movie' | 'tv'; tmdbId: number }[]) => {
      const missing = wanted.filter(
        (one) => !details[detailsKey(one.mediaType, one.tmdbId)]
      );

      if (!missing.length) {
        return;
      }

      const fetched = await Promise.all(
        // Deduped first: the 4K and non-4K variants of one title are two rows and
        // one title.
        [
          ...new Set(
            missing.map((one) => detailsKey(one.mediaType, one.tmdbId))
          ),
        ]
          .map((key) => {
            const [mediaType, tmdbId] = key.split(':');

            return { key, mediaType, tmdbId: Number(tmdbId) };
          })
          .map(async ({ key, mediaType, tmdbId }) => {
            try {
              const response = await sdk.coreApi.get<MediaDetails>(
                `${mediaType}/${tmdbId}`
              );

              return [key, response.data] as const;
            } catch {
              return null;
            }
          })
      );

      // An explicit guard rather than `!== null`: the predicate's return type is what
      // narrows the array, and a bare comparison leaves it `(T | null)[]`.
      const resolved = fetched.filter(
        (one): one is Exclude<typeof one, null> => one !== null
      );

      if (resolved.length) {
        setDetails((current) => ({
          ...current,
          ...Object.fromEntries(resolved),
        }));
      }
    },
    [sdk, details]
  );

  /** The same, for the requesters and deciders named on the visible rows. */
  const loadUsers = useCallback(
    async (ids: number[]) => {
      const missing = [...new Set(ids)].filter(
        (id) => id !== sdk.user.id && !users[id]
      );

      if (!missing.length) {
        return;
      }

      const fetched = await Promise.all(
        missing.map(async (id) => {
          try {
            const response = await sdk.coreApi.get<CoreUser>(`user/${id}`);

            return [id, response.data] as const;
          } catch {
            return null;
          }
        })
      );

      const resolved = fetched.filter(
        (one): one is Exclude<typeof one, null> => one !== null
      );

      if (resolved.length) {
        setUsers((current) => ({
          ...current,
          ...Object.fromEntries(resolved),
        }));
      }
    },
    [sdk, users]
  );

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

  // Deliberately not `useSWR`, even though `swr` is a shared specifier: the host
  // publishes its own SWR *instance*, so a panel using it inherits the app's
  // global fetcher, which is not scoped to this extension. A panel that wants SWR
  // should pass `sdk.api` as an explicit fetcher.
  useEffect(() => {
    void load(page);
  }, [load, page]);

  useEffect(() => {
    void loadRemovable();
  }, [loadRemovable]);

  // Metadata follows whatever is on screen, from either source, so a title shown
  // in the picker and in a row is fetched once. `loadDetails`/`loadUsers` close
  // over their caches and no-op when there is nothing new, which is what keeps
  // this from looping on its own `setDetails`.
  useEffect(() => {
    const rows = data?.results ?? [];

    void loadDetails([
      ...rows
        .filter((row): row is RemovalRequestRow & { tmdbId: number } =>
          Boolean(row.tmdbId)
        )
        .map((row) => ({ mediaType: row.mediaType, tmdbId: row.tmdbId })),
      ...(removable ?? []).map((entry) => ({
        mediaType: entry.mediaType,
        tmdbId: entry.tmdbId,
      })),
    ]);

    void loadUsers(
      rows.flatMap((row) => [
        row.requestedById,
        ...(row.modifiedById != null ? [row.modifiedById] : []),
      ])
    );
  }, [data, removable, loadDetails, loadUsers]);

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

    const label = titleFor(row) ?? `media #${row.mediaId}`;

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
        `The removal request for ${titleFor(row) ?? `media #${row.mediaId}`} was withdrawn.`,
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

  const create = async () => {
    const entry = (removable ?? []).find((one) => entryKey(one) === selected);

    // The only thing checked here: that something is selected at all. Everything
    // the server rejects on is still left to the server and its message shown
    // verbatim — the picker's flags can be stale by the time a click lands.
    if (!entry) {
      sdk.notify('Choose which of your requests to remove.', 'error');
      return;
    }

    setCreating(true);

    const label =
      details[detailsKey(entry.mediaType, entry.tmdbId)] !== undefined
        ? titleOf(details[detailsKey(entry.mediaType, entry.tmdbId)])
        : `media #${entry.mediaId}`;

    try {
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

      setSelected('');
      setPage(1);
      await load(1);
      await loadRemovable();
    } catch (e) {
      sdk.notify(
        messageOf(e, 'That removal request could not be opened.'),
        'error'
      );
    } finally {
      setCreating(false);
    }
  };

  /** The cached title for a row, or `undefined` while metadata is in flight. */
  function titleFor(row: RemovalRequestRow): string | undefined {
    if (row.tmdbId === null) {
      return undefined;
    }

    const cached = details[detailsKey(row.mediaType, row.tmdbId)];

    return cached ? titleOf(cached) : undefined;
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
  const selectedEntry = offerable.find((one) => entryKey(one) === selected);

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

      <div className="mb-6 rounded-xl bg-gray-800 p-4 ring-1 ring-gray-700">
        <h4 className="text-sm font-semibold text-white">Request a removal</h4>
        <p className="mt-1 text-xs text-gray-400">
          These are the requests you have made. Choosing one asks an
          administrator to delete it; you cannot delete anything yourself.
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
          <>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                aria-label="Choose one of your requests to remove"
              >
                <option value="">Choose one of your requests…</option>
                {offerable.map((entry) => {
                  const cached =
                    details[detailsKey(entry.mediaType, entry.tmdbId)];
                  // Falls back to the ids while metadata loads, so the picker is
                  // usable on the first paint rather than empty.
                  const label = cached
                    ? `${titleOf(cached)}${
                        yearOf(cached) ? ` (${yearOf(cached)})` : ''
                      }`
                    : `${
                        entry.mediaType === 'movie' ? 'Movie' : 'Series'
                      } #${entry.mediaId}`;

                  return (
                    <option key={entryKey(entry)} value={entryKey(entry)}>
                      {label}
                      {entry.is4k ? ' · 4K' : ''}
                      {entry.available ? '' : ' · not available yet'}
                    </option>
                  );
                })}
              </select>
              <button
                type="button"
                className="button-md bg-indigo-600 text-white disabled:opacity-50"
                disabled={creating || !selected}
                onClick={() => void create()}
              >
                {creating ? 'Submitting…' : 'Request removal'}
              </button>
            </div>

            {/* The poster of what is selected, so the choice is confirmed by
                looking rather than by trusting a dropdown label. */}
            {selectedEntry && (
              <div className="mt-3 flex items-center">
                <a
                  href={mediaHref(
                    selectedEntry.mediaType,
                    selectedEntry.tmdbId
                  )}
                  target="_blank"
                  rel="noreferrer"
                  className="w-10 flex-shrink-0 overflow-hidden rounded-md"
                >
                  <img
                    src={posterUrl(
                      sdk,
                      details[
                        detailsKey(
                          selectedEntry.mediaType,
                          selectedEntry.tmdbId
                        )
                      ]
                    )}
                    alt=""
                    width={600}
                    height={900}
                    className="h-auto w-full object-cover"
                  />
                </a>
                <p className="ml-3 text-xs text-gray-400">
                  Removing the {selectedEntry.is4k ? '4K' : 'non-4K'} version.
                  4K and non-4K live on separate servers, so the other one is
                  left alone.
                </p>
              </div>
            )}
          </>
        )}
      </div>

      {error ? (
        <p className="text-sm text-red-500">{error}</p>
      ) : loading && !data ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : !rows.length ? (
        <p className="text-sm text-gray-400">No removal requests yet.</p>
      ) : (
        <div className="space-y-4">
          {rows.map((row) => {
            const isOwn = row.requestedById === sdk.user.id;
            const isPending = row.status === RemovalRequestStatus.PENDING;
            const hasFailed = row.status === RemovalRequestStatus.FAILED;
            const busy = busyId === row.id;
            const confirming = confirmingId === row.id;
            const showActions =
              (canManage && (isPending || hasFailed)) || (isOwn && isPending);
            const cached =
              row.tmdbId === null
                ? undefined
                : details[detailsKey(row.mediaType, row.tmdbId)];

            return (
              // The `RequestList` card, restated: backdrop behind, poster and
              // title on the left, the fields and the controls on the right.
              <div
                key={row.id}
                className="relative flex w-full flex-col justify-between overflow-hidden rounded-xl bg-gray-800 py-2 text-gray-400 shadow-md ring-1 ring-gray-700 xl:flex-row"
              >
                {cached?.backdropPath && (
                  <div className="absolute inset-0 z-0 w-full xl:w-2/3">
                    <img
                      src={sdk.imageUrl(
                        `https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${cached.backdropPath}`,
                        'tmdb'
                      )}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                    <div
                      className="absolute inset-0"
                      style={{
                        backgroundImage:
                          'linear-gradient(90deg, rgba(31, 41, 55, 0.47) 0%, rgba(31, 41, 55, 1) 100%)',
                      }}
                    />
                  </div>
                )}

                <div className="relative flex w-full flex-col justify-between overflow-hidden sm:flex-row">
                  <div className="relative z-10 flex w-full items-center overflow-hidden px-4 sm:pr-0 xl:w-5/12">
                    {row.tmdbId !== null ? (
                      <a
                        href={mediaHref(row.mediaType, row.tmdbId)}
                        className="w-12 flex-shrink-0 overflow-hidden rounded-md transition duration-300 hover:scale-105"
                      >
                        <img
                          src={posterUrl(sdk, cached)}
                          alt=""
                          width={600}
                          height={900}
                          className="h-auto w-full object-cover"
                        />
                      </a>
                    ) : (
                      <span className="w-12 flex-shrink-0 overflow-hidden rounded-md">
                        <img
                          src={POSTER_FALLBACK}
                          alt=""
                          width={600}
                          height={900}
                          className="h-auto w-full object-cover"
                        />
                      </span>
                    )}
                    <div className="flex min-w-0 flex-col justify-center pl-2 xl:pl-4">
                      {cached && yearOf(cached) && (
                        <div className="pt-0.5 text-xs font-medium text-white sm:pt-1">
                          {yearOf(cached)}
                        </div>
                      )}
                      {row.tmdbId !== null ? (
                        <a
                          href={mediaHref(row.mediaType, row.tmdbId)}
                          className="mr-2 min-w-0 truncate text-lg font-bold text-white hover:underline xl:text-xl"
                        >
                          {cached
                            ? titleOf(cached)
                            : `${
                                row.mediaType === 'movie' ? 'Movie' : 'Series'
                              } #${row.mediaId}`}
                        </a>
                      ) : (
                        // The media row is gone — deleted from Seerr entirely,
                        // not merely removed from an arr. The request is kept
                        // because it is the record that a removal happened.
                        <span className="mr-2 min-w-0 truncate text-lg font-bold text-white xl:text-xl">
                          Media #{row.mediaId} (no longer in Seerr)
                        </span>
                      )}
                      {row.is4k && (
                        <div className="mt-1">
                          <span className="inline-flex items-center rounded-full border border-indigo-500 bg-indigo-500 bg-opacity-80 px-2 py-0.5 text-xs font-medium text-indigo-100">
                            4K
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="z-10 mt-4 flex w-full flex-col justify-center gap-1 overflow-hidden px-4 text-sm sm:mt-0 xl:w-4/12">
                    <div className="card-field">
                      <span className="card-field-name">Status</span>
                      <StatusBadge status={row.status} />
                    </div>
                    <div className="card-field">
                      <span className="card-field-name">Requested</span>
                      <span className="flex truncate text-sm text-gray-300">
                        <FormattedRelativeTime
                          value={secondsFromNow(row.createdAt)}
                          updateIntervalInSeconds={1}
                          numeric="auto"
                        />
                        <span className="ml-1">
                          by{' '}
                          <UserLabel
                            sdk={sdk}
                            userId={row.requestedById}
                            user={users[row.requestedById]}
                          />
                        </span>
                      </span>
                    </div>
                    {row.modifiedById != null && (
                      <div className="card-field">
                        <span className="card-field-name">Modified</span>
                        <span className="flex truncate text-sm text-gray-300">
                          <FormattedRelativeTime
                            value={secondsFromNow(row.updatedAt)}
                            updateIntervalInSeconds={1}
                            numeric="auto"
                          />
                          <span className="ml-1">
                            by{' '}
                            <UserLabel
                              sdk={sdk}
                              userId={row.modifiedById}
                              user={users[row.modifiedById]}
                            />
                          </span>
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="z-10 mt-4 flex w-full flex-col items-stretch justify-center gap-2 px-4 sm:mt-0 xl:w-3/12">
                    {hasFailed && (
                      <p className="text-xs text-red-400">
                        Radarr or Sonarr refused this removal and nothing was
                        deleted. Approving it again retries — unless no server
                        is configured for this media, in which case a retry will
                        not help and the notification said so.
                      </p>
                    )}

                    {showActions && (
                      <>
                        {canManage &&
                          (isPending || hasFailed) &&
                          (confirming ? (
                            <>
                              {/* A confirm step in the card rather than a
                                  `window.confirm`: this is the only irreversible
                                  action any panel in this repo takes, and the
                                  sentence naming exactly what gets deleted has to
                                  be on screen at the moment the decision is
                                  made. */}
                              <span className="text-xs text-red-400">
                                This deletes the {row.is4k ? '4K ' : ''}files
                                for{' '}
                                {cached
                                  ? titleOf(cached)
                                  : `media #${row.mediaId}`}{' '}
                                from{' '}
                                {row.mediaType === 'movie'
                                  ? 'Radarr'
                                  : 'Sonarr'}
                                , and cannot be undone. Continue?
                              </span>
                              <button
                                type="button"
                                className="button-md bg-red-600 text-white disabled:opacity-50"
                                disabled={busy}
                                onClick={() => void decide(row, 'approve')}
                              >
                                {busy ? 'Removing…' : 'Yes, delete the files'}
                              </button>
                              <button
                                type="button"
                                className="button-md bg-gray-700 text-white disabled:opacity-50"
                                disabled={busy}
                                onClick={() => setConfirmingId(undefined)}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="button-md bg-green-600 text-white disabled:opacity-50"
                              disabled={busy}
                              onClick={() => setConfirmingId(row.id)}
                            >
                              {hasFailed ? 'Retry removal' : 'Approve'}
                            </button>
                          ))}

                        {canManage && isPending && !confirming && (
                          <button
                            type="button"
                            className="button-md bg-gray-700 text-white disabled:opacity-50"
                            disabled={busy}
                            onClick={() => void decide(row, 'decline')}
                          >
                            Decline
                          </button>
                        )}

                        {/* Offered to the owner only while the row is still
                            pending. After that the files are already gone and the
                            row is the only record that a deletion happened, so
                            the server requires `manage` to delete it — a
                            different action from changing your mind, and not
                            offered as one. */}
                        {isOwn && isPending && !confirming && (
                          <button
                            type="button"
                            className="button-md bg-gray-700 text-white disabled:opacity-50"
                            disabled={busy}
                            onClick={() => void withdraw(row)}
                          >
                            Withdraw
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
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
            <button
              type="button"
              className="button-md bg-gray-700 text-white disabled:opacity-50"
              disabled={loading || page <= 1}
              onClick={() => setPage((current) => Math.max(current - 1, 1))}
            >
              Previous
            </button>
            <button
              type="button"
              className="button-md bg-gray-700 text-white disabled:opacity-50"
              disabled={loading || page >= totalPages}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default RemovalRequestsPanel;
