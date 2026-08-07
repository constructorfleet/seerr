/**
 * The Tautulli adapter — plays read through `sdk.tautulli`.
 *
 * The shortest of the two, and worth reading first, because almost everything it
 * would otherwise have to do is done by the host: `sdk.tautulli` already converts
 * seconds to milliseconds, stringifies rating keys, and hands over an episode's
 * series key. What is left is the part only an extension can do — deciding which
 * users to ask about, and folding episode plays up into per-title counts.
 *
 * Note what this file does *not* contain: a hostname, a port, an API key, or an
 * HTTP call. The operator's Tautulli credential never reaches extension code; see
 * `sdk.tautulli` in `docs/specs/extension-system.md`.
 */
import type { ExtensionTautulli, SeerrUser } from '@seerr/extension-sdk';

import type { SourcePlay, WatchSource } from './types';

/**
 * Builds the adapter over the host capability and the users to ask about.
 *
 * The users are passed in rather than looked up here because *which* users to
 * sync is a policy question the caller owns (all of them, on a cron; one of them,
 * on demand), and because the caller has already loaded them to resolve the
 * Plex-id join.
 */
export function tautulliSource(
  tautulli: ExtensionTautulli,
  users: SeerrUser[]
): WatchSource {
  return {
    name: 'tautulli',
    async plays(since: Date): Promise<SourcePlay[]> {
      // Keyed `${plexUserId}:${ratingKey}` — the pair the aggregate is per.
      const totals = new Map<string, SourcePlay>();

      for (const user of users) {
        // A local user who never linked Plex has no id Tautulli knows, so there
        // is nothing to ask about. Skipped rather than guessed at: matching on
        // username instead would attribute someone else's plays to them.
        if (user.plexId == null) {
          continue;
        }

        for (const record of await tautulli.userHistory(user.plexId)) {
          // The host caps and orders the history; the window is this extension's
          // own `trend_days` setting, so it filters here.
          if (record.watchedAt < since) {
            continue;
          }

          // The series key when there is one, so twelve episodes of a series
          // count as twelve plays of *that series* rather than twelve separate
          // titles core has no row for — core's `media` table is keyed on the
          // series, not the episode.
          const key = record.seriesRatingKey ?? record.ratingKey;
          const mapKey = `${record.plexUserId}:${key}`;
          const existing = totals.get(mapKey);

          if (existing) {
            existing.plays += 1;
            existing.watchTimeMs += record.durationMs;
            // Newest wins. The host returns newest-first, so this only matters
            // if that ever changes — cheap insurance against a silent reordering.
            if (
              !existing.lastPlayedAt ||
              record.watchedAt > existing.lastPlayedAt
            ) {
              existing.lastPlayedAt = record.watchedAt;
            }
            continue;
          }

          totals.set(mapKey, {
            sourceUserId: record.plexUserId,
            ratingKey: key,
            // `episode` is Tautulli's unit, not a media type core has; a play of
            // an episode is a play of the series.
            mediaType: record.mediaType === 'movie' ? 'movie' : 'tv',
            plays: 1,
            watchTimeMs: record.durationMs,
            lastPlayedAt: record.watchedAt,
          });
        }
      }

      return [...totals.values()];
    },
  };
}
