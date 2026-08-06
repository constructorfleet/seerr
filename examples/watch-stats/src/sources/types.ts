/**
 * The one shape both watch-history sources are reduced to.
 *
 * Tautulli and Tracearr answer genuinely different questions. Tautulli has
 * per-user and per-item aggregates but its history rows carry only Plex rating
 * keys — it knows nothing of tmdbIds. Tracearr's history rows carry `tmdb_id`,
 * `imdb_id` and `tvdb_id` directly, but it has no per-user-per-title aggregate,
 * so its counts have to be folded up from paginated history.
 *
 * Rather than let those differences leak into the sync, each source returns
 * {@link SourcePlay} rows and the sync is written once against that. Two
 * consequences worth being explicit about, because they are what make the
 * abstraction honest rather than a lowest common denominator:
 *
 * - **Identity is a union, not a single key.** A source supplies whichever of
 *   `ratingKey` / `tmdbId` it actually has, and resolution to a core media id is
 *   the *sync's* job (via `sdk.media.findByRatingKey` / `findByTmdbId`). Forcing
 *   every source to produce a tmdbId would mean Tautulli's adapter doing the core
 *   lookup itself, which puts core's schema knowledge in the wrong place.
 * - **`plays` and `watchTimeMs` are already aggregated per (user, title).** Both
 *   sources can produce that; neither can produce a reliable stable id per
 *   individual play, which is why the stored table is an aggregate. See
 *   `entity/PlayStat.ts`.
 */

/** One user's total play of one title, as a source reports it. */
export interface SourcePlay {
  /**
   * The media server's user id — Tautulli's `user_id`, Tracearr's `user.id`.
   * Joined to a Seerr user by `plexId`, which is the only bridge either source
   * offers; usernames are not reliably equal.
   */
  sourceUserId: number;
  /** Plex rating key, when the source reports one. */
  ratingKey?: string;
  /** TMDB id, when the source reports one. */
  tmdbId?: number;
  mediaType: 'movie' | 'tv';
  plays: number;
  /** Milliseconds. Tautulli reports seconds; its adapter converts. */
  watchTimeMs: number;
  lastPlayedAt?: Date;
}

/**
 * What a source can do. Deliberately two methods and no `connect`/`dispose`:
 * both are stateless HTTP, and a lifecycle an adapter does not need is a
 * lifecycle the sync has to get right for no benefit.
 */
export interface WatchSource {
  /** For the settings page and the panel's "reading from" line. */
  readonly name: 'tautulli' | 'tracearr';
  /**
   * Every play the source can report within the window, aggregated per
   * (user, title).
   *
   * @param since Only plays at or after this instant.
   */
  plays(since: Date): Promise<SourcePlay[]>;
}

/**
 * Why a source could not be built, for the panel to show the operator.
 *
 * A discriminated result rather than a thrown error because "the operator has
 * not configured Tracearr yet" is the *normal* state of a fresh install, and it
 * needs to reach the panel as a sentence rather than a stack trace in the log.
 */
export type SourceResolution =
  | { ok: true; source: WatchSource }
  | { ok: false; reason: string };
