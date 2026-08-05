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
 *   which is why the SDK hands over a pre-scoped `api` instance instead, and why
 *   `AxiosInstance` below is an `import type`: a type-only import emits nothing, so
 *   the specifier never reaches the browser at all.
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
<<<<<<< HEAD
 * What is deliberately *not* here is the auto-approval switch. It is a declared
 * setting the host renders at `/settings/extensions/media-removal` behind core's
 * `ADMIN` gate. A control whose effect is deleting files without review does not
 * belong on the screen a requester uses, gated on an extension permission; see
 * `SETTING_KEY` in `index.ts`.
 *
 * ## It looks like the Requests page, and the server does the work
 *
 * Rows are posters, titles and years, laid out like `RequestList` — because a
 * removal request *is* a request, and a screen that lists media by numeric id
 * while the page next to it lists the same media by poster is not a different
 * design, it is an unfinished one.
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
 * So `posterUrl` arrives as a string this file puts straight into an `<img src>`.
 * That is also why there is no `sdk.imageUrl`: the one host thing a panel cannot
 * reuse is `CachedImage` (it is `@app/*` source and a Next `<Image>`), and the
 * server is where the rewriting belongs anyway.
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
=======
 * - **The "request removal" button.** In core this was a control on the media
 *   detail page, beside the request button, where a person already is when they
 *   decide they are done with a title. A panel cannot edit core's
 *   `RequestButton` — it renders in a route of its own and has no media in scope
 *   — so what stands in for it is the picker below. What it does *not* do is ask
 *   for a media id, which is what this panel did first and was wrong twice over:
 *   nobody knows their media ids, and a freeform field implies the eligible set
 *   is open when it is entirely derivable — **you may unrequest what you
 *   requested**. So the server offers that set from `/candidates` and this picks
 *   from it. Closing the gap the rest of the way still needs a core extension
 *   point for *media-page actions*, a slot an extension can contribute a control
 *   to with the media in scope; that is follow-up work on the extension system,
 *   and it is now the only part of the button a better panel could not replace.
 * - **The auto-approval switch.** `SETTING_KEY` in `index.ts` explains why it
 *   lives in this extension's kv store rather than in `MainSettings`. The
 *   consequence lands here: this panel is the *only* place the switch exists, so
 *   its copy says so instead of pointing at Settings → General.
>>>>>>> origin/develop
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

/** One removable thing, as `/candidates` reports it. */
interface Candidate {
  mediaId: number;
  is4k: boolean;
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  available: boolean;
  /** A `Date` column, so it arrives JSON-serialized. */
  requestedAt: string;
}

interface CandidatesResponse {
  results: Candidate[];
  /** Whether the server's source read was truncated. */
  more: boolean;
  scope: 'all' | 'own';
}

/** The value a `<select>` option carries, since it can only hold a string. */
const candidateKey = (candidate: Pick<Candidate, 'mediaId' | 'is4k'>): string =>
  `${candidate.mediaId}:${candidate.is4k}`;

/**
 * Titles for a set of candidates, resolved from core's TMDB-backed endpoints.
 *
 * Not through `sdk.api`: that instance is scoped to
 * `/api/v1/ext/media-removal/`, and these are core's own routes. `fetch` rather
 * than a second axios instance because `axios` is not a shared module specifier —
 * importing it as a value would pull a second copy of the library into the page.
 * These are GETs, so none of the CSRF behaviour `sdk.api` exists to inherit
 * applies.
 *
 * A title that will not resolve is not an error worth surfacing: the candidate is
 * still removable, and the panel falls back to naming it by id. So every lookup
 * settles, and failures simply leave the map without an entry.
 */
async function fetchTitles(
  candidates: Candidate[]
): Promise<Map<number, string>> {
  const wanted = new Map<number, 'movie' | 'tv'>();

  for (const candidate of candidates) {
    wanted.set(candidate.tmdbId, candidate.mediaType);
  }

  const entries = await Promise.all(
    [...wanted].map(async ([tmdbId, mediaType]) => {
      try {
        const response = await fetch(
          `/api/v1/${mediaType === 'movie' ? 'movie' : 'tv'}/${tmdbId}`
        );

        if (!response.ok) {
          return undefined;
        }

        const body = (await response.json()) as {
          title?: string;
          name?: string;
          releaseDate?: string;
          firstAirDate?: string;
        };
        const title = body.title ?? body.name;

        if (!title) {
          return undefined;
        }

        // The year disambiguates remakes, which is the case where a bare title
        // would leave someone unsure which one they are about to delete.
        const year = (body.releaseDate ?? body.firstAirDate ?? '').slice(0, 4);

        return [tmdbId, year ? `${title} (${year})` : title] as const;
      } catch {
        return undefined;
      }
    })
  );

  return new Map(entries.filter((entry): entry is [number, string] => !!entry));
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
    <a
      href={`/users/${user.id}`}
      className="group inline-flex items-center truncate align-middle"
    >
      {/* A plain `<img>`: `CachedImage` is a Next `<Image>` behind `@app/*` and
          needs the host's build. The avatar URL is whatever core stores, which
          core itself never proxies. */}
      <img
        src={user.avatar}
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
<<<<<<< HEAD
  const [removable, setRemovable] = useState<RemovableEntry[]>();
=======
  /** What the caller may ask to have removed, from the server. */
  const [candidates, setCandidates] = useState<CandidatesResponse>();
  const [titles, setTitles] = useState<Map<number, string>>(new Map());
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  /** The `candidateKey` of the selection, or `''` for none. */
>>>>>>> origin/develop
  const [selected, setSelected] = useState('');
  const [creating, setCreating] = useState(false);

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
<<<<<<< HEAD
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

=======
   * Reloads the eligible set, then its titles.
   *
   * Titles are fetched in a second pass and stored separately so the picker is
   * usable the moment the candidates arrive — a title lookup is one request per
   * distinct title against TMDB's cache, and blocking the list on all of them
   * would make the common case (a handful of requests) feel slower than it is.
   */
  const loadCandidates = useCallback(async () => {
    setLoadingCandidates(true);

    try {
      const response = await sdk.api.get<CandidatesResponse>('candidates');
      setCandidates(response.data);
      setTitles(await fetchTitles(response.data.results));
    } catch {
      // Left undefined, which renders as "could not be loaded". Nothing is
      // notified: this runs on mount, and a toast for a list the user has not
      // asked for yet would be noise.
      setCandidates(undefined);
    } finally {
      setLoadingCandidates(false);
    }
  }, [sdk]);

  useEffect(() => {
    void loadCandidates();
  }, [loadCandidates]);

>>>>>>> origin/develop
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
<<<<<<< HEAD
      // stops being shown with buttons that would now 404. The picker goes too: a
      // decline frees the variant to be asked for again.
      await load(page);
      await loadRemovable();
=======
      // stops being shown with buttons that would now 404. The candidate list
      // moves too: declining releases the block a pending row held, so the media
      // becomes offerable again.
      await Promise.all([load(page), loadCandidates()]);
>>>>>>> origin/develop
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
<<<<<<< HEAD
      sdk.notify(
        `The removal request for ${labelFor(row)} was withdrawn.`,
        'success'
      );
      await load(page);
      await loadRemovable();
=======
      sdk.notify(`Removal request #${row.id} was withdrawn.`, 'success');
      // Withdrawing releases the duplicate block, so what was withdrawn is
      // immediately offerable again.
      await Promise.all([load(page), loadCandidates()]);
>>>>>>> origin/develop
    } catch (e) {
      sdk.notify(
        messageOf(e, 'That removal request could not be withdrawn.'),
        'error'
      );
    } finally {
      setBusyId(undefined);
    }
  };

<<<<<<< HEAD
  const create = async () => {
    const entry = (removable ?? []).find((one) => entryKey(one) === selected);

    // The only thing checked here: that something is selected at all. Everything
    // the server rejects on is still left to the server and its message shown
    // verbatim — the picker's flags can be stale by the time a click lands.
    if (!entry) {
      sdk.notify('Choose which of your requests to remove.', 'error');
      return;
    }

=======
  const create = async (candidate: Candidate) => {
>>>>>>> origin/develop
    setCreating(true);

    const label =
      entry.media?.title ?? fallbackLabel(entry.mediaType, entry.mediaId);

    try {
      // Still sent as `mediaId`/`is4k` rather than an opaque key: the create
      // route is the contract, and it re-checks every rule `/candidates` applied.
      // A candidate can go stale between the two — someone else opens a request,
      // or the media is removed — and when it does the server's own message is
      // shown verbatim, exactly as before.
      const response = await sdk.api.post<RemovalRequestRow>('requests', {
<<<<<<< HEAD
        mediaId: entry.mediaId,
        is4k: entry.is4k,
=======
        mediaId: candidate.mediaId,
        is4k: candidate.is4k,
>>>>>>> origin/develop
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
<<<<<<< HEAD
      await load(1);
      await loadRemovable();
=======
      // Both lists move: the new row appears in one, and the candidate it came
      // from leaves the other.
      await Promise.all([load(1), loadCandidates()]);
>>>>>>> origin/develop
    } catch (e) {
      sdk.notify(
        messageOf(e, 'That removal request could not be opened.'),
        'error'
      );
      // Reloaded on failure too. Most rejections here mean the eligible set has
      // moved since it was read — a duplicate was opened, the media was removed —
      // so leaving the stale option selected would invite the same failure again.
      await loadCandidates();
    } finally {
      setCreating(false);
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
  const selectedEntry = offerable.find((one) => entryKey(one) === selected);

  const options = candidates?.results ?? [];
  const selectedCandidate = options.find(
    (candidate) => candidateKey(candidate) === selected
  );

  /**
   * How a candidate reads in the picker.
   *
   * The 4K marker is part of the label rather than a separate checkbox, which is
   * what this form had before: the variant is a property of the thing being
   * chosen, not an independent option, and a checkbox let someone ask for a 4K
   * removal of a title that has no 4K version — a combination the server then
   * had to reject. Choosing from labelled variants makes that unrepresentable.
   */
  const labelFor = (candidate: Candidate): string => {
    const title =
      titles.get(candidate.tmdbId) ??
      `${candidate.mediaType === 'movie' ? 'Movie' : 'Series'} #${candidate.mediaId}`;

    return `${title}${candidate.is4k ? ' · 4K' : ''}${
      candidate.available ? '' : ' · not available yet'
    }`;
  };

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

<<<<<<< HEAD
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
                  // Falls back to the ids when the server had no metadata to
                  // resolve, so an entry is still offerable rather than nameless.
                  const label = entry.media
                    ? `${entry.media.title}${
                        entry.media.year ? ` (${entry.media.year})` : ''
                      }`
                    : fallbackLabel(entry.mediaType, entry.mediaId);

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
                {selectedEntry.media ? (
                  <a
                    href={mediaHref(selectedEntry.media)}
                    target="_blank"
                    rel="noreferrer"
                    className="w-10 flex-shrink-0 overflow-hidden rounded-md"
                  >
                    <img
                      src={posterUrl(selectedEntry.media)}
                      alt=""
                      width={600}
                      height={900}
                      className="h-auto w-full object-cover"
                    />
                  </a>
                ) : (
                  <span className="w-10 flex-shrink-0 overflow-hidden rounded-md">
                    <img
                      src={POSTER_FALLBACK}
                      alt=""
                      width={600}
                      height={900}
                      className="h-auto w-full object-cover"
                    />
                  </span>
                )}
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
=======
      {/* The stand-in for core's media-page button, per the header above. It
          picks from what the server says is removable rather than asking for an
          id, so the only reachable failures are ones the set went stale on. */}
      <div className="mb-6 rounded-md border border-gray-700 bg-gray-800/40 p-4">
        <h4 className="text-base font-semibold text-white">
          Request a removal
        </h4>
        <p className="mt-1 text-sm text-gray-400">
          {canManage
            ? 'Pick something to have deleted. Your permissions let you remove anything, so this lists everything anyone has requested — and because you can approve removals, your own are carried out immediately.'
            : 'Pick something you asked for to have it deleted again. Only media you requested yourself can be removed, so that is what this lists.'}
        </p>

        {loadingCandidates && !candidates ? (
          <p className="mt-3 text-sm text-gray-400">
            Loading what you can remove…
          </p>
        ) : !candidates ? (
          <p className="mt-3 text-sm text-gray-500">
            The list of what you can remove could not be loaded. Reload the
            panel to try again.
          </p>
        ) : !options.length ? (
          /* An empty set is the normal state for a new user, not a failure, and
             it is also the answer to "why is there no field here" — so it says
             what would put something in the list. */
          <p className="mt-3 text-sm text-gray-500">
            {canManage
              ? 'Nothing is available to remove: nobody has an outstanding request whose media is still present.'
              : 'You have nothing to remove yet. Media you request appears here once it has been added, and leaves once it is gone.'}
          </p>
        ) : (
          <>
            {/* `form-row`/`form-input-area` are the app's own form primitives, so
                this label, control and spacing match every other form in Seerr
                rather than approximating them. */}
            <div className="form-row">
              <label htmlFor="removal-candidate" className="text-label">
                Media to remove
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <select
                    id="removal-candidate"
                    value={selected}
                    disabled={creating}
                    onChange={(e) => setSelected(e.target.value)}
                  >
                    <option value="">Choose something to remove…</option>
                    {options.map((candidate) => (
                      <option
                        key={candidateKey(candidate)}
                        value={candidateKey(candidate)}
                      >
                        {labelFor(candidate)}
                      </option>
                    ))}
                  </select>
                </div>
                {candidates.more && (
                  <p className="mt-2 text-xs text-gray-500">
                    Only the most recent requests are listed, so this may not be
                    everything.
                  </p>
                )}
                {canManage && (
                  <p className="mt-2 text-xs text-gray-500">
                    You can remove media nobody requested as well, but there is
                    no request to list it from — so it will not appear here.
                  </p>
                )}
              </div>
            </div>

            <div className="actions">
              <div className="flex justify-end">
                <button
                  type="button"
                  className="button-md bg-indigo-600 text-white disabled:opacity-50"
                  disabled={creating || !selectedCandidate}
                  onClick={() =>
                    selectedCandidate && void create(selectedCandidate)
                  }
                >
                  {creating ? 'Requesting…' : 'Request removal'}
                </button>
              </div>
            </div>

            {/* Shown only once something is selected, and naming that thing. The
                generic version of this sentence was easy to skip past; a
                specific one is read, which matters when the outcome is deletion.
                For a `manage` holder it is not a warning about a later approval
                step — there isn't one — so the wording differs. */}
            {selectedCandidate && (
              <p className="mt-2 text-xs text-gray-400">
                {canManage
                  ? `This deletes the ${selectedCandidate.is4k ? '4K ' : ''}files for ${labelFor(selectedCandidate)} from ${selectedCandidate.mediaType === 'movie' ? 'Radarr' : 'Sonarr'} straight away, and cannot be undone.`
                  : `This asks for the ${selectedCandidate.is4k ? '4K ' : ''}version to be deleted. ${selectedCandidate.is4k ? 'The non-4K version is on a separate server and is left alone.' : 'A 4K version, if there is one, is on a separate server and is left alone.'}`}
              </p>
            )}
          </>
        )}
      </div>

      {canManage && (
        <div className="mb-6 rounded-md border border-gray-700 bg-gray-800/40 p-4">
          <h4 className="text-base font-semibold text-white">
            Approve removals of media that is not available yet
          </h4>
          <p className="mt-1 text-sm text-gray-400">
            While this is on, a removal request for media that is not available
            yet is carried out the moment it is made — the files are deleted
            without anyone reviewing it. Media that is already available always
            needs approval, whatever this is set to. This switch is not on
            Settings → General with the rest of the auto-approval options; this
            panel is the only place it exists.
          </p>
          {autoApprove === undefined ? (
            <p className="mt-3 text-sm text-gray-500">
              This setting could not be read, so it is not shown rather than
              shown as off. Reload the panel to try again.
            </p>
          ) : (
            /* `mb-0` and `font-normal` undo the app's global `label` rule, which
               is `mb-1 block font-bold` for form labels sitting above their
               control. This one sits beside a checkbox, so the block margin
               would push the text off its centre line. `gap-3` rather than
               `mr-2`: the app's checkboxes are 24px, and half a rem beside one
               is what read as no gap at all. */
            <label className="mb-0 mt-4 flex items-center gap-3 text-sm font-normal text-gray-300">
              <input
                type="checkbox"
                checked={autoApprove}
                disabled={savingSetting}
                onChange={(e) => void saveSetting(e.target.checked)}
              />
              Delete unavailable media without review
            </label>
          )}
        </div>
      )}
>>>>>>> origin/develop

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
            const media = row.media;

            return (
              // The `RequestList` card, restated: backdrop behind, poster and
              // title on the left, the fields and the controls on the right.
              <div
                key={row.id}
                className="relative flex w-full flex-col justify-between overflow-hidden rounded-xl bg-gray-800 py-2 text-gray-400 shadow-md ring-1 ring-gray-700 xl:flex-row"
              >
                {media?.backdropUrl && (
                  <div className="absolute inset-0 z-0 w-full xl:w-2/3">
                    <img
                      src={media.backdropUrl}
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
                    {media ? (
                      <a
                        href={mediaHref(media)}
                        className="w-12 flex-shrink-0 overflow-hidden rounded-md transition duration-300 hover:scale-105"
                      >
                        <img
                          src={posterUrl(media)}
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
                      {media?.year && (
                        <div className="pt-0.5 text-xs font-medium text-white sm:pt-1">
                          {media.year}
                        </div>
                      )}
                      {media ? (
                        <a
                          href={mediaHref(media)}
                          className="mr-2 min-w-0 truncate text-lg font-bold text-white hover:underline xl:text-xl"
                        >
                          {media.title}
                        </a>
                      ) : (
                        // Either the media row is gone — deleted from Seerr
                        // entirely, not merely removed from an arr — or TMDB
                        // would not answer. The request is kept regardless,
                        // because it is the record that a removal happened.
                        <span className="mr-2 min-w-0 truncate text-lg font-bold text-white xl:text-xl">
                          {fallbackLabel(row.mediaType, row.mediaId)} (no
                          metadata)
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
                            user={row.requestedBy}
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
                              user={row.modifiedBy}
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
                                for {labelFor(row)} from{' '}
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
