/**
 * One "this user played this media, this many times" row — an aggregate, not an
 * event log.
 *
 * ## Why an aggregate and not a play log
 *
 * The obvious design is a row per play, mirroring what the source returns. It is
 * the wrong one here: Tautulli and Tracearr already keep the play log, they keep
 * it better (they see the sessions live), and copying it means this extension
 * owns a growing table it can only ever have a stale, partial copy of. Worse,
 * neither source exposes a stable per-play id — Tautulli's `row_id` is
 * documented as unstable and Tracearr paginates by cursor — so a resync could
 * not tell an already-imported play from a new one, and every sync would either
 * duplicate rows or need a full-table diff.
 *
 * So the sync recomputes: for each (user, media) pair it writes the count and the
 * most recent play it can see, and a row is replaced wholesale. That makes the
 * table small, bounded by users × watched titles, and idempotent — running the
 * job twice is indistinguishable from running it once, which is the property that
 * matters for something on a cron.
 *
 * The cost is that this cannot answer "what did I watch on the 4th" — the panel
 * asks "what have I watched, and how much", which is what it has.
 *
 * Three constraints inherited from living in the *core* database, all of them the
 * same as `watch-history`'s `WatchEvent`:
 *
 * - **The `ext_watch-stats_` table prefix is enforced**, not conventional: the
 *   loader refuses an entity whose table name is outside it.
 * - **`userId` and `mediaId` are plain columns, not relations.** A foreign key
 *   from an extension table into a core one turns uninstalling the extension into
 *   a schema problem for core rather than a `DROP TABLE`. The cost is that a
 *   deleted user leaves rows behind, which the sync job prunes.
 * - **`lastPlayedAt` uses the SDK's `DbAwareColumn`.** Seerr runs on sqlite or
 *   Postgres, which disagree about date types; a bare `type: 'datetime'` works on
 *   one and fails on the other, which is a bug an author cannot reproduce locally.
 */
import { DbAwareColumn } from '@seerr/extension-sdk';
import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity({ name: 'ext_watch-stats_play' })
// The sync's read-modify-write is keyed on exactly this pair, and it is what
// makes "recompute and replace" safe: a second concurrent sync cannot insert a
// duplicate aggregate for the same user and title.
@Unique('ext_watch-stats_play_user_media', ['userId', 'mediaId'])
// The panel's two queries are "this user's titles, most-played first" and the
// server-wide roll-up by media, so each gets an index.
@Index('ext_watch-stats_play_user_plays', ['userId', 'plays'])
@Index('ext_watch-stats_play_media', ['mediaId'])
export class PlayStat {
  @PrimaryGeneratedColumn()
  public id: number;

  /** Core `User.id`. Not a relation; see the class comment. */
  @Column({ type: 'integer' })
  public userId: number;

  /** Core `Media.id`, resolved from the source's rating key or tmdbId. */
  @Column({ type: 'integer' })
  public mediaId: number;

  @Column({ type: 'varchar' })
  public mediaType: 'movie' | 'tv';

  /** How many plays the source reports, as of the last sync. */
  @Column({ type: 'integer', default: 0 })
  public plays: number;

  /**
   * Total watch time in **milliseconds**, which is Tracearr's unit; Tautulli
   * reports seconds and the adapter converts. Stored as the finer unit so the
   * conversion is lossless in the direction it happens.
   *
   * `bigint` rather than `integer`: a heavy user of a long-running series passes
   * 2³¹ ms in under a month of watching, and a silent overflow here would look
   * like a plausible number rather than an error. TypeORM maps `bigint` to a
   * *string* on some drivers, hence the type.
   */
  @Column({ type: 'bigint', default: 0 })
  public watchTimeMs: string;

  /** The most recent play the source reports. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastPlayedAt?: Date | null;

  /**
   * Which source this row came from, so switching sources does not silently
   * blend two sets of numbers that count things differently — the sync discards
   * rows from the other source rather than trying to reconcile them.
   */
  @Column({ type: 'varchar', default: 'tautulli' })
  public source: 'tautulli' | 'tracearr';

  @DbAwareColumn({ type: 'datetime' })
  public syncedAt: Date;

  constructor(init?: Partial<PlayStat>) {
    Object.assign(this, init);
  }
}
