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
 *   `AxiosInstance` below is an `import type`: a type-only import emits nothing,
 *   so the specifier never reaches the browser at all.
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
 * ## The picker, and what it replaced
 *
 * This used to be a text box asking for a numeric media id, standing in for
 * core's media-page request button. That was bad in a way worth recording: nobody
 * knows their media ids, and since the server only permits removal of media you
 * requested, *every* id a user could successfully guess was already known to the
 * server. So the rule is enumerated instead — `GET /removable` returns the
 * caller's own requests and the panel offers them as a list.
 *
 * It is still not parity with a control on the media page, because a panel renders
 * in a route of its own with no media in scope and cannot show a poster or a
 * title — only a type, a variant, and a link out to the media page. Closing that
 * properly needs a core extension point for media-page actions, which is follow-up
 * work on the extension system rather than something this panel can fix.
 */
import type { AxiosInstance } from 'axios';
import { useCallback, useEffect, useState } from 'react';
import type { IntlShape } from 'react-intl';

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

const STATUS_CLASSES: Record<number, string> = {
  [RemovalRequestStatus.PENDING]: 'bg-yellow-500 text-yellow-900',
  [RemovalRequestStatus.APPROVED]: 'bg-indigo-500 text-white',
  [RemovalRequestStatus.DECLINED]: 'bg-gray-600 text-gray-200',
  [RemovalRequestStatus.FAILED]: 'bg-red-600 text-white',
  [RemovalRequestStatus.COMPLETED]: 'bg-green-500 text-green-900',
};

/** One `ext_media-removal_request` row, as it arrives over the wire. */
interface RemovalRequestRow {
  id: number;
  status: number;
  mediaId: number;
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

/** Matches `DEFAULT_PAGE_SIZE` in `index.ts`. The server caps `take` at 100. */
const PAGE_SIZE = 20;

/** The `<option>` value for one entry, and the way back to its fields. */
const entryKey = (entry: RemovableEntry): string =>
  `${entry.mediaId}:${entry.is4k ? '4k' : 'hd'}`;

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

    try {
      const response = await sdk.api.post<RemovalRequestRow>(
        `requests/${row.id}/${status}`
      );
      const settled = response.data;

      if (settled.status === RemovalRequestStatus.FAILED) {
        sdk.notify(
          `The removal of media #${settled.mediaId} failed and nothing was deleted. Approving it again retries.`,
          'error'
        );
      } else if (settled.status === RemovalRequestStatus.COMPLETED) {
        sdk.notify(`Media #${settled.mediaId} was removed.`, 'success');
      } else if (settled.status === RemovalRequestStatus.DECLINED) {
        sdk.notify(`Removal request #${settled.id} was declined.`, 'success');
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
      sdk.notify(`Removal request #${row.id} was withdrawn.`, 'success');
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
          `Removal request #${created.id} was submitted and is waiting for an administrator to review it.`,
          'success'
        );
      } else if (created.status === RemovalRequestStatus.FAILED) {
        sdk.notify(
          'The removal was approved automatically but failed, so nothing was deleted.',
          'error'
        );
      } else {
        sdk.notify(
          `Media #${created.mediaId} was approved for removal automatically and has been deleted.`,
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

      <div className="mb-6 rounded-md border border-gray-700 p-4">
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
              >
                <option value="">Choose one of your requests…</option>
                {offerable.map((entry) => (
                  <option key={entryKey(entry)} value={entryKey(entry)}>
                    {entry.mediaType === 'movie' ? 'Movie' : 'Series'} ·{' '}
                    {entry.is4k ? '4K' : 'HD'} · tmdb {entry.tmdbId}
                    {entry.available ? '' : ' · not available yet'}
                  </option>
                ))}
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
            {/* A link out rather than a title, because a panel gets no poster or
                title from the SDK — only what the removal rows carry. It is the
                closest this can come to letting someone confirm what they picked. */}
            {selected &&
              (() => {
                const entry = offerable.find(
                  (one) => entryKey(one) === selected
                );

                return entry ? (
                  <p className="mt-2 text-xs text-gray-500">
                    <a
                      href={`/${entry.mediaType === 'movie' ? 'movie' : 'tv'}/${
                        entry.tmdbId
                      }`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open this title
                    </a>{' '}
                    to check it is the one you mean.
                  </p>
                ) : null;
              })()}
            <p className="mt-2 text-xs text-gray-500">
              4K and non-4K live on separate servers, so removing one leaves the
              other alone.
            </p>
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
        <ul className="divide-y divide-gray-700">
          {rows.map((row) => {
            const isOwn = row.requestedById === sdk.user.id;
            const isPending = row.status === RemovalRequestStatus.PENDING;
            const hasFailed = row.status === RemovalRequestStatus.FAILED;
            const busy = busyId === row.id;
            const confirming = confirmingId === row.id;
            const showActions =
              (canManage && (isPending || hasFailed)) || (isOwn && isPending);

            return (
              <li key={row.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-white">
                    <span
                      className={`mr-2 rounded px-2 py-0.5 text-xs ${
                        STATUS_CLASSES[row.status] ??
                        'bg-gray-600 text-gray-200'
                      }`}
                    >
                      {STATUS_LABELS[row.status] ?? `Status ${row.status}`}
                    </span>
                    {row.mediaType === 'movie' ? 'Movie' : 'Series'} #
                    {row.mediaId}
                    {row.is4k && (
                      <span className="ml-2 text-xs text-gray-500">4K</span>
                    )}
                  </span>
                  {/* `sdk.intl` rather than `toLocaleString`, so dates match the
                      rest of the app in the user's chosen locale. */}
                  <span className="text-gray-400">
                    {sdk.intl.formatDate(new Date(row.createdAt), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </span>
                </div>

                {/* Ids rather than names: the rows hold plain integers, not
                    relations, so there is no requester to join to. */}
                <div className="mt-1 text-xs text-gray-500">
                  Requested by {isOwn ? 'you' : `user #${row.requestedById}`}
                  {row.modifiedById != null &&
                    ` · decided by ${
                      row.modifiedById === sdk.user.id
                        ? 'you'
                        : `user #${row.modifiedById}`
                    }`}
                  {row.updatedAt !== row.createdAt &&
                    ` · updated ${sdk.intl.formatDate(new Date(row.updatedAt), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}`}
                </div>

                {hasFailed && (
                  <p className="mt-1 text-xs text-red-400">
                    Radarr or Sonarr refused this removal and nothing was
                    deleted. Approving it again retries — unless no server is
                    configured for this media, in which case a retry will not
                    help and the notification said so.
                  </p>
                )}

                {showActions && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {canManage &&
                      (isPending || hasFailed) &&
                      (confirming ? (
                        <>
                          {/* A confirm step in the row rather than a
                              `window.confirm`: this is the only irreversible
                              action any panel in this repo takes, and the
                              sentence naming exactly what gets deleted has to be
                              on screen at the moment the decision is made. */}
                          <span className="text-xs text-red-400">
                            This deletes the {row.is4k ? '4K ' : ''}files for
                            media #{row.mediaId} from{' '}
                            {row.mediaType === 'movie' ? 'Radarr' : 'Sonarr'},
                            and cannot be undone. Continue?
                          </span>
                          <button
                            type="button"
                            className="button-sm bg-red-600 text-white disabled:opacity-50"
                            disabled={busy}
                            onClick={() => void decide(row, 'approve')}
                          >
                            {busy ? 'Removing…' : 'Yes, delete the files'}
                          </button>
                          <button
                            type="button"
                            className="button-sm bg-gray-700 text-white disabled:opacity-50"
                            disabled={busy}
                            onClick={() => setConfirmingId(undefined)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="button-sm bg-green-600 text-white disabled:opacity-50"
                          disabled={busy}
                          onClick={() => setConfirmingId(row.id)}
                        >
                          {hasFailed ? 'Retry removal' : 'Approve'}
                        </button>
                      ))}

                    {canManage && isPending && !confirming && (
                      <button
                        type="button"
                        className="button-sm bg-gray-700 text-white disabled:opacity-50"
                        disabled={busy}
                        onClick={() => void decide(row, 'decline')}
                      >
                        Decline
                      </button>
                    )}

                    {/* Offered to the owner only while the row is still pending.
                        After that the files are already gone and the row is the
                        only record that a deletion happened, so the server
                        requires `manage` to delete it — a different action from
                        changing your mind, and not offered as one. */}
                    {isOwn && isPending && !confirming && (
                      <button
                        type="button"
                        className="button-sm bg-gray-700 text-white disabled:opacity-50"
                        disabled={busy}
                        onClick={() => void withdraw(row)}
                      >
                        Withdraw
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
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
              className="button-sm bg-gray-700 text-white disabled:opacity-50"
              disabled={loading || page <= 1}
              onClick={() => setPage((current) => Math.max(current - 1, 1))}
            >
              Previous
            </button>
            <button
              type="button"
              className="button-sm bg-gray-700 text-white disabled:opacity-50"
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
