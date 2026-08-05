/**
 * One "user watched this media" row.
 *
 * Three things here are non-obvious, and all three are consequences of an
 * extension table living in the *core* database.
 *
 * **The table prefix is enforced, not conventional.** The loader refuses an
 * entity whose table name is outside `ext_<id>_`, because an unprefixed
 * `@Entity({ name })` would collide with — or shadow — a core table.
 *
 * **`userId` and `mediaId` are plain columns, not relations.** Declaring a
 * TypeORM relation to `User` or `Media` means importing those classes, which
 * means depending on Seerr's unpublished entity graph; and a foreign key from an
 * extension table into a core one turns uninstalling the extension into a schema
 * problem for core rather than a `DROP TABLE`. The cost is that a deleted user
 * leaves rows behind, which the `sync` job prunes.
 *
 * **`watchedAt` is stored as epoch milliseconds, not a date column.** Core
 * writes dates through `DbAwareColumn`, which rewrites `datetime` to `timestamp
 * with time zone` on Postgres by reading `isPgsql` off the live DataSource. An
 * extension has neither: `@server/utils/DbColumnHelper` is host-internal, and
 * entity classes are loaded at *discovery*, before the DataSource exists, so
 * there is nothing to ask about the dialect at decoration time. A bare
 * `type: 'datetime'` therefore works on sqlite and fails on Postgres — the exact
 * kind of bug that only shows up on someone else's deployment. `bigint` is
 * spelled the same in both dialects; the transformer keeps the `Date` API.
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * `bigint` comes back from the Postgres driver as a string and from sqlite as a
 * number, so both are handled rather than assuming either.
 */
const epochMillis = {
  to: (value: Date | undefined): string | null =>
    value ? String(value.getTime()) : null,
  from: (value: string | number | null): Date | undefined =>
    value == null ? undefined : new Date(Number(value)),
};

@Entity({ name: 'ext_watch-history_event' })
// The panel's only query is "this user's history, newest first", and the sync
// job's prune is by `userId`, so one composite index covers both.
@Index(['userId', 'watchedAt'])
export class WatchEvent {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'integer' })
  public userId: number;

  @Column({ type: 'integer' })
  public mediaId: number;

  @Column({ type: 'varchar' })
  public mediaType: 'movie' | 'tv';

  @Column({ type: 'integer', nullable: true })
  public tmdbId?: number | null;

  /**
   * How the row got here: `event` for a core transition the extension observed,
   * `manual` for one the user recorded through the panel. Kept because the two
   * mean different things to a user reading their history, and because a resync
   * must be able to leave manual rows alone.
   */
  @Column({ type: 'varchar', default: 'event' })
  public source: 'event' | 'manual';

  @Column({ type: 'bigint', transformer: epochMillis })
  public watchedAt: Date;

  constructor(init?: Partial<WatchEvent>) {
    Object.assign(this, init);
  }
}
