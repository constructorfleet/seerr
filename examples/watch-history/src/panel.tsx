/**
 * The Watch History panel.
 *
 * A panel is a pre-built **ESM** bundle the host `import()`s at runtime, so two
 * things about this file are not negotiable:
 *
 * - **It default-exports a component taking a single `sdk` prop.** The host
 *   reads `mod.default` and renders `<PanelComponent sdk={sdk} />`; anything else
 *   surfaces as "The panel bundle has no default-exported component."
 * - **Its only bare imports are ones the host's import map provides** — `react`,
 *   `react/jsx-runtime`, `react-intl`, `swr` and so on, listed in
 *   `server/lib/extensions/sharedModuleSpecifiers.ts`. This is the sharp edge of
 *   the whole panel mechanism: an unmapped specifier does not fail loudly, it
 *   resolves to a *second copy* of the package, which renders correctly and then
 *   throws on the first hook. Note in particular that there is no `axios` entry —
 *   which is why the SDK hands over a pre-scoped `api` instance instead.
 *
 * It cannot import from `@app/*`: it is not part of the host's build, and its
 * `sdk` prop is deliberately the only channel in.
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

interface WatchRow {
  id: number;
  userId: number;
  mediaId: number;
  mediaType: 'movie' | 'tv';
  tmdbId?: number | null;
  source: 'event' | 'manual';
  /** A `Date` column, so it arrives JSON-serialized as an ISO string. */
  watchedAt: string;
}

interface HistoryResponse {
  results: WatchRow[];
  lastSync: number | null;
}

const WatchHistoryPanel = ({ sdk }: { sdk: PanelSdk }) => {
  const [data, setData] = useState<HistoryResponse>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const canViewAll = sdk.hasPermission('view_all');

  const load = useCallback(
    async (userId?: number) => {
      setLoading(true);
      setError(undefined);

      try {
        // Relative, because `sdk.api` is already scoped to
        // `/api/v1/ext/watch-history/` — including the CSRF behaviour non-GET
        // routes need.
        const response = await sdk.api.get<HistoryResponse>('history', {
          params: userId ? { userId } : {},
        });
        setData(response.data);
      } catch {
        setError('Your watch history could not be loaded.');
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
    void load();
  }, [load]);

  const rows = data?.results ?? [];

  return (
    <div className="mt-6">
      <div className="mb-6">
        <h3 className="heading">Watch History</h3>
        <p className="description">
          {canViewAll
            ? 'Everything you have watched. You can also view other users’ history.'
            : 'Everything you have watched.'}
        </p>
      </div>

      {error ? (
        <p className="text-sm text-red-500">{error}</p>
      ) : loading && !data ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : !rows.length ? (
        <p className="text-sm text-gray-400">Nothing watched yet.</p>
      ) : (
        <ul className="divide-y divide-gray-700">
          {rows.map((row) => (
            <li key={row.id} className="flex justify-between py-3 text-sm">
              <span className="text-white">
                {row.mediaType === 'movie' ? 'Movie' : 'Series'} #{row.mediaId}
                {row.source === 'manual' && (
                  <span className="ml-2 text-xs text-gray-500">rewatch</span>
                )}
              </span>
              {/* `sdk.intl` rather than `toLocaleString`, so dates match the
                  rest of the app in the user's chosen locale. */}
              <span className="text-gray-400">
                {sdk.intl.formatDate(new Date(row.watchedAt), {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              </span>
            </li>
          ))}
        </ul>
      )}

      {data?.lastSync != null && (
        <p className="mt-6 text-xs text-gray-500">
          Last synced{' '}
          {sdk.intl.formatDate(new Date(data.lastSync), {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
        </p>
      )}
    </div>
  );
};

export default WatchHistoryPanel;
