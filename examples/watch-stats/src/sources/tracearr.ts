/**
 * The Tracearr adapter — plays read from the operator's Tracearr server over its
 * public API.
 *
 * The instructive contrast with `tautulli.ts`. Tautulli is a *core* integration,
 * so the host owns the credential and the extension gets a capability. Tracearr is
 * not something core knows about, so this extension declares its own settings and
 * makes its own HTTP calls — which is what an extension integrating anything core
 * has never heard of will look like.
 *
 * Three decisions worth the words:
 *
 * - **`fetch`, not axios.** Node's global `fetch` is available in every runtime
 *   Seerr supports, so this adds no dependency. An extension *can* depend on axios,
 *   but then it has to be installed alongside the extension, and a version skew
 *   with core's is a debugging session nobody wants.
 * - **Cursor pagination is followed, with a page cap.** Tracearr's `/history`
 *   returns `meta.nextCursor`; following it to exhaustion on a cron against a
 *   large server is an unbounded crawl, so the cap is here and the truncation is
 *   logged by the caller rather than passed off as a complete answer.
 * - **Responses are validated structurally, not with zod.** Only the fields used
 *   are read, each guarded — a schema for Tracearr's full `HistoryRecord` would be
 *   a second copy of somebody else's API to keep up to date, and every field it
 *   validated that this file ignores would be a reason to reject a response this
 *   could have used.
 */
import type { SourcePlay, WatchSource } from './types';

/** How many pages of history to follow before giving up. 100 records per page. */
const MAX_PAGES = 20;

/** The subset of Tracearr's `HistoryRecord` this reads. */
interface TracearrHistoryRecord {
  tmdb_id?: number | null;
  media_type?: string | null;
  duration_ms?: number | null;
  watched_at?: string | null;
  user?: { id?: number | null } | null;
}

interface TracearrHistoryResponse {
  data?: TracearrHistoryRecord[] | null;
  meta?: { nextCursor?: string | null } | null;
}

export interface TracearrOptions {
  /** Base URL, including any path prefix. A trailing slash is tolerated. */
  url: string;
  /** A public API token — `trr_pub_…` — from Tracearr's Settings › General. */
  token: string;
  /** Called with each page's truncation or parse problem. */
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

export function tracearrSource(options: TracearrOptions): WatchSource {
  // Normalized once. A trailing slash on the operator's setting would otherwise
  // produce `//api/v2/...`, which some reverse proxies redirect and others 404.
  const base = options.url.replace(/\/+$/, '');

  const page = async (
    since: Date,
    cursor?: string
  ): Promise<TracearrHistoryResponse> => {
    const params = new URLSearchParams({
      since: since.toISOString(),
      limit: '100',
    });

    if (cursor) {
      params.set('cursor', cursor);
    }

    const response = await fetch(
      `${base}/api/v2/public/history?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: 'application/json',
        },
      }
    );

    if (!response.ok) {
      // Thrown rather than swallowed: unlike a host capability, this adapter's
      // caller is the one that decides an unreachable source is not fatal, and it
      // needs the status to tell "wrong token" from "server down".
      throw new Error(
        `Tracearr answered ${response.status} ${response.statusText}`
      );
    }

    return (await response.json()) as TracearrHistoryResponse;
  };

  return {
    name: 'tracearr',
    async plays(since: Date): Promise<SourcePlay[]> {
      // Keyed `${userId}:${tmdbId}` — Tracearr gives tmdbIds directly, which is
      // the join Tautulli cannot do.
      const totals = new Map<string, SourcePlay>();
      let cursor: string | undefined;

      for (let pages = 0; pages < MAX_PAGES; pages++) {
        const body = await page(since, cursor);

        for (const record of body.data ?? []) {
          const userId = record.user?.id;
          const tmdbId = record.tmdb_id;

          // Both are required to attribute the play, and Tracearr can report a
          // record with neither — a play of something it could not match to TMDB,
          // or by a user it no longer has. Nothing to aggregate; skipped.
          if (userId == null || tmdbId == null || !record.watched_at) {
            continue;
          }

          const watchedAt = new Date(record.watched_at);

          if (Number.isNaN(watchedAt.getTime())) {
            options.warn('Skipped a Tracearr record with an unparseable date', {
              watchedAt: record.watched_at,
            });
            continue;
          }

          const key = `${userId}:${tmdbId}`;
          const existing = totals.get(key);
          // Tracearr reports milliseconds already, which is why `SourcePlay`'s
          // unit is milliseconds — see the note there.
          const durationMs = record.duration_ms ?? 0;

          if (existing) {
            existing.plays += 1;
            existing.watchTimeMs += durationMs;
            if (!existing.lastPlayedAt || watchedAt > existing.lastPlayedAt) {
              existing.lastPlayedAt = watchedAt;
            }
            continue;
          }

          totals.set(key, {
            sourceUserId: userId,
            tmdbId,
            // Tracearr reports `episode` for an episode play; core's row is the
            // series, so both collapse to `tv` — the same fold `tautulli.ts` does.
            mediaType: record.media_type === 'movie' ? 'movie' : 'tv',
            plays: 1,
            watchTimeMs: durationMs,
            lastPlayedAt: watchedAt,
          });
        }

        cursor = body.meta?.nextCursor ?? undefined;

        if (!cursor) {
          return [...totals.values()];
        }
      }

      // Reached only when the cap stopped an unfinished crawl. Logged rather than
      // returned silently, because a partial answer that looks complete makes the
      // panel show counts that are quietly wrong.
      options.warn(
        `Stopped reading Tracearr history after ${MAX_PAGES} pages; counts may be incomplete`,
        { since: since.toISOString() }
      );

      return [...totals.values()];
    },
  };
}
