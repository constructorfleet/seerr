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
 * **`watchedAt` uses the SDK's `DbAwareColumn`, not a bare `@Column`.** Seerr
 * runs on sqlite or Postgres, which disagree about date types: a plain
 * `type: 'datetime'` works on sqlite and fails on Postgres, a bug an author
 * cannot reproduce on their own dev box. The SDK's helper resolves the type the
 * same way core does, so this reads as an ordinary date column and stays
 * portable. It replaced a `bigint` epoch-millis workaround this extension
 * carried before the helper existed.
 */
import { DbAwareColumn } from '@constructorfleet/extension-sdk';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

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

  @DbAwareColumn({ type: 'datetime' })
  public watchedAt: Date;

  constructor(init?: Partial<WatchEvent>) {
    Object.assign(this, init);
  }
}
