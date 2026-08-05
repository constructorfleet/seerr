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
 * ## This panel carries two things core would have owned
 *
 * Both are honest compromises rather than parity, and both are what converting a
 * drafted core feature into an extension actually cost:
 *
 * - **The "request removal" button.** In core this was a control on the media
 *   detail page, beside the request button, where a person already is when they
 *   decide they are done with a title. A panel cannot edit core's
 *   `RequestButton` — it renders in a route of its own and has no media in scope
 *   — so what stands in for it is the form below, which asks for a numeric media
 *   id. That is plainly worse: nobody knows their media ids. Closing the gap
 *   properly needs a core extension point for *media-page actions*, a slot an
 *   extension can contribute a control to with the media passed in, and that is
 *   worth filing as follow-up work on the extension system rather than worked
 *   around here. It is the one limitation of the panel mechanism this conversion
 *   exposed that a better panel could not fix.
 * - **The auto-approval switch.** `SETTING_KEY` in `index.ts` explains why it
 *   lives in this extension's kv store rather than in `MainSettings`. The
 *   consequence lands here: this panel is the *only* place the switch exists, so
 *   its copy says so instead of pointing at Settings → General.
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
  [RemovalRequestStatus.PENDING]: 'Pending',
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

interface SettingsResponse {
  autoApproveWhenUnavailable: boolean;
}

/** Matches `DEFAULT_PAGE_SIZE` in `index.ts`. The server caps `take` at 100. */
const PAGE_SIZE = 20;

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
  const [mediaId, setMediaId] = useState('');
  const [is4k, setIs4k] = useState(false);
  const [creating, setCreating] = useState(false);
  const [autoApprove, setAutoApprove] = useState<boolean>();
  const [savingSetting, setSavingSetting] = useState(false);

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

  // Deliberately not `useSWR`, even though `swr` is a shared specifier: the host
  // publishes its own SWR *instance*, so a panel using it inherits the app's
  // global fetcher, which is not scoped to this extension. A panel that wants SWR
  // should pass `sdk.api` as an explicit fetcher.
  useEffect(() => {
    void load(page);
  }, [load, page]);

  // The setting's *read* is `manage`-gated as well as its write, so fetching it
  // without the permission would be a guaranteed 403 about a control that is not
  // even rendered.
  useEffect(() => {
    if (!canManage) {
      return;
    }

    void (async () => {
      try {
        const response = await sdk.api.get<SettingsResponse>('settings');
        setAutoApprove(response.data.autoApproveWhenUnavailable);
      } catch {
        // Left `undefined`, which renders as "could not be read" rather than as
        // off. Showing an unknown value as off would be a lie in the
        // reassuring direction, and an operator toggling it twice to "fix" the
        // display would have turned unreviewed file deletion on.
        setAutoApprove(undefined);
      }
    })();
  }, [sdk, canManage]);

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
      // stops being shown with buttons that would now 404.
      await load(page);
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
    const parsed = Number(mediaId);

    // The only thing checked here, and only to keep an empty field from becoming
    // a request the server has to answer. Everything the server rejects on —
    // unknown media, an already-removed or untracked variant, an open duplicate,
    // media the caller never requested — is state this panel cannot know, so it
    // is left to the server and its message is shown verbatim.
    if (!Number.isInteger(parsed) || parsed <= 0) {
      sdk.notify('Enter the numeric id of the media to remove.', 'error');
      return;
    }

    setCreating(true);

    try {
      const response = await sdk.api.post<RemovalRequestRow>('requests', {
        mediaId: parsed,
        is4k,
      });
      const created = response.data;

      // The 201 carries a settled status too: a request the caller was allowed
      // to auto-approve has already been carried out by the time it answers, so
      // "waiting for approval" would be wrong for it.
      if (created.status === RemovalRequestStatus.PENDING) {
        sdk.notify(
          `Removal request #${created.id} was opened and is waiting for approval.`,
          'success'
        );
      } else if (created.status === RemovalRequestStatus.FAILED) {
        sdk.notify(
          'The removal was approved automatically but failed, so nothing was deleted.',
          'error'
        );
      } else {
        sdk.notify(
          `Media #${created.mediaId} was approved for removal and has been deleted.`,
          'success'
        );
      }

      setMediaId('');
      setIs4k(false);
      setPage(1);
      await load(1);
    } catch (e) {
      sdk.notify(
        messageOf(e, 'That removal request could not be opened.'),
        'error'
      );
    } finally {
      setCreating(false);
    }
  };

  const saveSetting = async (next: boolean) => {
    setSavingSetting(true);

    try {
      const response = await sdk.api.post<SettingsResponse>('settings', {
        autoApproveWhenUnavailable: next,
      });
      setAutoApprove(response.data.autoApproveWhenUnavailable);
      sdk.notify(
        response.data.autoApproveWhenUnavailable
          ? 'Removals of media that is not available yet will now be carried out without review.'
          : 'Every removal now needs approval.',
        'success'
      );
    } catch (e) {
      sdk.notify(messageOf(e, 'That setting could not be saved.'), 'error');
    } finally {
      setSavingSetting(false);
    }
  };

  const rows = data?.results ?? [];
  const pageInfo = data?.pageInfo;
  const totalPages = Math.max(pageInfo?.pages ?? 1, 1);

  return (
    <div className="mt-6">
      <div className="mb-6">
        <h3 className="heading">Removal Requests</h3>
        <p className="description">
          {canManage
            ? 'Review requests to delete media, and choose whether media that is not available yet is removed without review. Approving one deletes the files from Radarr or Sonarr.'
            : 'Ask for media you requested to be deleted, and see what you have asked for. Only your own requests are listed here.'}
        </p>
      </div>

      {/* The stand-in for core's media-page button, per the header above. A
          numeric media id is a poor thing to ask a person for; it is what a panel
          can ask for. */}
      <div className="mb-6 rounded-md border border-gray-700 p-4">
        <h4 className="text-sm font-semibold text-white">Request a removal</h4>
        <p className="mt-1 text-xs text-gray-400">
          Enter the id of the media you want deleted. You can only request
          removal of media you requested yourself
          {canManage
            ? ', though your permissions let you remove anything — and your own requests are approved and carried out immediately'
            : ''}
          .
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input
            className="short"
            inputMode="numeric"
            placeholder="Media ID"
            value={mediaId}
            onChange={(e) => setMediaId(e.target.value)}
          />
          <label className="flex items-center text-sm text-gray-300">
            <input
              type="checkbox"
              className="mr-2"
              checked={is4k}
              onChange={(e) => setIs4k(e.target.checked)}
            />
            Remove the 4K version
          </label>
          <button
            type="button"
            className="button-md bg-indigo-600 text-white disabled:opacity-50"
            disabled={creating}
            onClick={() => void create()}
          >
            {creating ? 'Requesting…' : 'Request removal'}
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-500">
          4K and non-4K live on separate servers, so removing one leaves the
          other alone.
        </p>
      </div>

      {canManage && (
        <div className="mb-6 rounded-md border border-gray-700 p-4">
          <h4 className="text-sm font-semibold text-white">
            Approve removals of media that is not available yet
          </h4>
          <p className="mt-1 text-xs text-gray-400">
            While this is on, a removal request for media that is not available
            yet is carried out the moment it is made — the files are deleted
            without anyone reviewing it. Media that is already available always
            needs approval, whatever this is set to. This switch is not on
            Settings → General with the rest of the auto-approval options; this
            panel is the only place it exists.
          </p>
          {autoApprove === undefined ? (
            <p className="mt-3 text-xs text-gray-500">
              This setting could not be read, so it is not shown rather than
              shown as off. Reload the panel to try again.
            </p>
          ) : (
            <label className="mt-3 flex items-center text-sm text-gray-300">
              <input
                type="checkbox"
                className="mr-2"
                checked={autoApprove}
                disabled={savingSetting}
                onChange={(e) => void saveSetting(e.target.checked)}
              />
              Delete unavailable media without review
            </label>
          )}
        </div>
      )}

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
