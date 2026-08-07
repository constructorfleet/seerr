/**
 * The Watch Stats panel.
 *
 * A panel is a pre-built **ESM** bundle the host `import()`s at runtime, which
 * imposes the two rules every panel lives under: it default-exports a component
 * taking a single `sdk` prop, and its only bare imports are specifiers the host's
 * import map provides (`react`, `react-intl`, `swr`, `@constructorfleet/extension-ui` — see
 * `server/lib/extensions/sharedModuleSpecifiers.ts`). An unmapped specifier does
 * not fail loudly; it resolves to a second copy of the package, which renders and
 * then throws on the first hook.
 *
 * ## This panel uses the host's components, and that is the point
 *
 * The other two examples hand-write Tailwind classes. That works only by accident
 * and only for classes core happens to use elsewhere: `tailwind.config.js` scans
 * `src/pages/**` and `src/components/**`, so a class appearing *only* in a panel
 * bundle is never compiled and the element renders with no styling at all — no
 * console error, no log line. `media-removal`'s panel copies core's `Badge`
 * classes by hand for exactly this reason, and every one of those strings is a
 * silent breakage waiting for core to change a colour.
 *
 * Importing `@constructorfleet/extension-ui` avoids the whole class of problem: those
 * components live under `src/components/**`, so their classes *are* in the
 * stylesheet, and they are the same components core's own pages render. This
 * panel therefore writes almost no `className` of its own, and the few it does are
 * semantic classes from `src/styles/globals.css` (`heading`, `description`), which
 * are compiled unconditionally.
 *
 * ## Data comes from the server already presentable
 *
 * Every route below returns rows carrying a `details` object with `title`, `year`
 * and `posterUrl` — built server-side by `sdk.media.getDetails`. This file does no
 * metadata fetching and knows nothing of TMDB paths or the operator's `cacheImages`
 * setting. An extension is a backend that may optionally have a frontend.
 */
import type { ExtensionPanelSdk } from '@constructorfleet/extension-ui';
import {
  Alert,
  Badge,
  LoadingSpinner,
  Table,
} from '@constructorfleet/extension-ui';
import { useState } from 'react';
import useSWR from 'swr';

/** `ExtensionMediaDetails`, as the server embeds it. Restated: see the note below. */
interface MediaDetails {
  tmdbId: number;
  title: string;
  year: number | null;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
}

interface StatRow {
  mediaId: number;
  mediaType: 'movie' | 'tv';
  plays: number;
  watchTimeMs: number;
  lastPlayedAt: string | null;
  details: MediaDetails | null;
}

interface StatsResponse {
  results: StatRow[];
  /** Which source the numbers came from, `null` when none is configured. */
  source: 'tautulli' | 'tracearr' | null;
  /** A sentence for the operator when there is no source. */
  sourceProblem: string | null;
  tautulliHost: string | null;
  lastSync: number | null;
}

interface TrendingRow {
  mediaId: number;
  mediaType: 'movie' | 'tv';
  plays: number;
  viewers: number;
  details: MediaDetails | null;
}

type Tab = 'mine' | 'trending' | 'suggestions';

/** Whole hours, then one decimal below that — "0.4 hours" reads worse than "24m". */
const formatWatchTime = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);

  return `${hours}h ${minutes % 60}m`;
};

/**
 * A poster and a title, the unit every tab is a list of.
 *
 * A plain `<img>` rather than the `CachedImage` this package also exports: that
 * one is a Next `<Image>`, which needs the host's image loader and its
 * `next.config.js` domains — neither of which a runtime-loaded bundle
 * participates in. `posterUrl` already honours the operator's `cacheImages`
 * setting, resolved server-side, so there is nothing left for the browser to do.
 */
const TitleCell = ({
  details,
  fallback,
}: {
  details: MediaDetails | null;
  fallback: string;
}) => (
  <div className="flex items-center">
    {details?.posterUrl ? (
      <img
        src={details.posterUrl}
        alt=""
        className="mr-4 h-16 w-10 flex-shrink-0 rounded-md object-cover"
      />
    ) : (
      <div className="mr-4 h-16 w-10 flex-shrink-0 rounded-md bg-gray-700" />
    )}
    <div>
      <div className="text-white">{details?.title ?? fallback}</div>
      {details?.year != null && (
        <div className="text-sm text-gray-400">{details.year}</div>
      )}
    </div>
  </div>
);

/**
 * This extension's id, which is also the namespace its catalog keys are merged
 * under. Kept as a constant rather than spelled into every lookup so a rename is
 * one edit — and it must match the manifest `id`.
 */
const EXTENSION_ID = 'watch-stats';

const WatchStatsPanel = ({ sdk }: { sdk: ExtensionPanelSdk }) => {
  const canViewAll = sdk.hasPermission('view_all');

  /**
   * Formats one of this extension's own strings from `i18n/<locale>.json`.
   *
   * The host merged those catalogs into its message map under `EXTENSION_ID`, so
   * a lookup is the prefixed id. `defaultMessage` is deliberately omitted: a key
   * missing from every catalog should render visibly as its id in development
   * rather than quietly falling back to English text held in two places.
   */
  const t = (key: string, values?: Record<string, string | number>) =>
    sdk.intl.formatMessage({ id: `${EXTENSION_ID}.${key}` }, values);
  const [tab, setTab] = useState<Tab>('mine');

  // `sdk.fetcher` rather than a bare `useSWR(path)`: `swr` is a shared specifier,
  // so the hook is the host's instance and its global fetcher is configured for
  // core's `/api/v1` routes. `sdk.fetcher` is bound to this extension's namespace,
  // and must be passed per call — there is no way to rebind the shared default for
  // one subtree without changing it for the host.
  const { data: stats, error: statsError } = useSWR<StatsResponse>(
    'stats',
    sdk.fetcher
  );
  const { data: trending } = useSWR<{ results: TrendingRow[] }>(
    // Not requested at all without the permission, rather than requested and
    // 403'd: a panel that fires a call it knows will be refused puts a red line in
    // the operator's log for a screen that rendered correctly.
    canViewAll && tab === 'trending' ? 'trending' : null,
    sdk.fetcher
  );
  const { data: suggestions } = useSWR<{ results: MediaDetails[] }>(
    tab === 'suggestions' ? 'suggestions' : null,
    sdk.fetcher
  );

  /**
   * Strings come from `i18n/<locale>.json`, declared as `provides.messages`. The
   * host merges those into its own message map under this extension's id, so `t`
   * below is just `sdk.intl.formatMessage` with the prefix applied — see the
   * helper at the bottom of this file.
   */
  const tabs: { key: Tab; label: string }[] = [
    { key: 'mine', label: t('tab.mine') },
    ...(canViewAll
      ? [{ key: 'trending' as Tab, label: t('tab.trending') }]
      : []),
    { key: 'suggestions', label: t('tab.suggestions') },
  ];

  return (
    <div className="mt-6">
      <div className="mb-6">
        <h3 className="heading">{t('heading')}</h3>
        <p className="description">
          {stats?.source === 'tracearr'
            ? t('source.tracearr')
            : stats?.tautulliHost
              ? t('source.tautulli', { host: stats.tautulliHost })
              : t('source.unknown')}
        </p>
      </div>

      {/* The unconfigured case, which is every fresh install. `Alert` is the
          host's own component, so it looks like core's own warnings. */}
      {stats?.sourceProblem && (
        <div className="mb-6">
          <Alert title={t('empty.source')} type="warning">
            {stats.sourceProblem}
          </Alert>
        </div>
      )}

      <nav className="mb-4 flex space-x-2">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => setTab(entry.key)}
            // `button-md` and the `bg-`/`text-` utilities are all classes core
            // uses in `src/components/**`, so they are in the stylesheet. A class
            // this panel invented would not be.
            className={
              tab === entry.key
                ? 'button-md bg-indigo-600 text-white'
                : 'button-md bg-gray-700 text-gray-300'
            }
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {statsError ? (
        <Alert title={t('error.stats')} type="error" />
      ) : !stats ? (
        <LoadingSpinner />
      ) : tab === 'mine' ? (
        !stats.results.length ? (
          <p className="text-sm text-gray-400">{t('empty.mine')}</p>
        ) : (
          <Table>
            <thead>
              <Table.TH>{t('column.title')}</Table.TH>
              <Table.TH>{t('column.plays')}</Table.TH>
              <Table.TH>{t('column.watchTime')}</Table.TH>
              <Table.TH>{t('column.lastPlayed')}</Table.TH>
            </thead>
            <Table.TBody>
              {stats.results.map((row) => (
                <tr key={row.mediaId}>
                  <Table.TD>
                    <TitleCell
                      details={row.details}
                      fallback={t('media.fallback', { id: row.mediaId })}
                    />
                  </Table.TD>
                  <Table.TD>
                    <Badge badgeType="primary">{row.plays}</Badge>
                  </Table.TD>
                  <Table.TD>{formatWatchTime(row.watchTimeMs)}</Table.TD>
                  <Table.TD>
                    {row.lastPlayedAt
                      ? // `sdk.intl` rather than `toLocaleString`, so dates match
                        // the rest of the app in the user's chosen locale.
                        sdk.intl.formatDate(new Date(row.lastPlayedAt), {
                          dateStyle: 'medium',
                        })
                      : '—'}
                  </Table.TD>
                </tr>
              ))}
            </Table.TBody>
          </Table>
        )
      ) : tab === 'trending' ? (
        !trending ? (
          <LoadingSpinner />
        ) : !trending.results.length ? (
          <p className="text-sm text-gray-400">{t('empty.trending')}</p>
        ) : (
          <Table>
            <thead>
              <Table.TH>{t('column.title')}</Table.TH>
              <Table.TH>{t('column.plays')}</Table.TH>
              <Table.TH>{t('column.viewers')}</Table.TH>
            </thead>
            <Table.TBody>
              {trending.results.map((row) => (
                <tr key={row.mediaId}>
                  <Table.TD>
                    <TitleCell
                      details={row.details}
                      fallback={t('media.fallback', { id: row.mediaId })}
                    />
                  </Table.TD>
                  <Table.TD>
                    <Badge badgeType="primary">{row.plays}</Badge>
                  </Table.TD>
                  <Table.TD>{row.viewers}</Table.TD>
                </tr>
              ))}
            </Table.TBody>
          </Table>
        )
      ) : !suggestions ? (
        <LoadingSpinner />
      ) : !suggestions.results.length ? (
        <p className="text-sm text-gray-400">{t('empty.suggestions')}</p>
      ) : (
        // A grid rather than a table: these are titles to browse, not numbers to
        // compare. Every class here was checked against the compiled stylesheet
        // — `grid-cols-4` and `sm:grid-cols-4` are *not* in it (core never writes
        // them), which is the silent-failure trap this file's header describes.
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {suggestions.results.map((suggestion) => (
            <li key={suggestion.tmdbId}>
              {suggestion.posterUrl ? (
                <img
                  src={suggestion.posterUrl}
                  alt=""
                  className="w-full rounded-lg object-cover"
                />
              ) : (
                <div className="h-48 w-full rounded-lg bg-gray-700" />
              )}
              <div className="mt-2 text-sm text-white">{suggestion.title}</div>
              {suggestion.year != null && (
                <div className="text-xs text-gray-400">{suggestion.year}</div>
              )}
            </li>
          ))}
        </ul>
      )}

      {stats?.lastSync != null && (
        <p className="mt-6 text-xs text-gray-500">
          {t('lastSync', {
            date: sdk.intl.formatDate(new Date(stats.lastSync), {
              dateStyle: 'medium',
              timeStyle: 'short',
            }),
          })}
        </p>
      )}
    </div>
  );
};

export default WatchStatsPanel;
