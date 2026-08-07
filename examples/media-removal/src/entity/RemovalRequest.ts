/**
 * One "please delete this" row.
 *
 * The in-core version of this feature used a `MediaRemovalRequest` entity with
 * `@ManyToOne` relations to `Media` and `User`. An extension cannot, and the
 * reasons are the same three that shape `WatchEvent` in the watch-history
 * example — they are worth restating because this entity is the one where the
 * missing relations are most tempting.
 *
 * **The table prefix is enforced, not conventional.** The loader refuses an
 * entity whose table name falls outside `ext_<id>_`, because an unprefixed
 * `@Entity({ name })` would collide with — or shadow — a core table. This
 * extension's tables therefore all read `ext_media-removal_*`.
 *
 * **`mediaId`, `requestedById` and `modifiedById` are plain columns, not
 * relations.** Declaring a TypeORM relation means importing `Media` and `User`,
 * which means depending on Seerr's unpublished entity graph; and a foreign key
 * from an extension table into a core one turns uninstalling the extension into a
 * schema problem for core rather than a `DROP TABLE`. The cost is real and
 * specific here: the in-core version got `onDelete: 'CASCADE'` for free, so
 * clearing a media row took its removal requests with it. This one keeps rows
 * pointing at ids that may no longer resolve, and the routes tolerate that — a
 * row whose media is gone has nothing left to remove, and the panel shows the id.
 *
 * **The date columns go through the SDK's `DbAwareColumn`, not a bare `@Column`.**
 * Seerr runs on sqlite or Postgres, which disagree about date types: a plain
 * `type: 'datetime'` works on sqlite and fails on Postgres — a portability bug the
 * author cannot reproduce on their own dev box. The helper resolves the type the
 * same way core does, and the migration resolves it the same way again through
 * `resolveColumnType`, which is what keeps the migrated schema and the entity
 * metadata in agreement.
 */
import { DbAwareColumn } from '@constructorfleet/extension-sdk';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * The state machine, with numbers **deliberately identical** to core's
 * `MediaRequestStatus`.
 *
 * An extension cannot import that enum: it lives at
 * `@server/constants/media`, which is application source with no published
 * package behind it. So the values are restated here — and restating them with
 * the same numbering is a decision, not a coincidence. An operator reading
 * `ext_media-removal_request.status` in a SQL client sees `2` and it means
 * APPROVED, exactly as it does in core's `media_request` table; a monitoring
 * query or a support answer that works for one works for the other. Renumbering
 * would have cost nothing at runtime and made every cross-table comparison a trap.
 *
 * `FAILED` is unreachable from a route: it is what an approved removal becomes
 * when Radarr/Sonarr refuses.
 */
export const RemovalRequestStatus = {
  PENDING: 1,
  APPROVED: 2,
  DECLINED: 3,
  FAILED: 4,
  COMPLETED: 5,
} as const;

export type RemovalRequestStatusValue =
  (typeof RemovalRequestStatus)[keyof typeof RemovalRequestStatus];

@Entity({ name: 'ext_media-removal_request' })
export class RemovalRequest {
  @PrimaryGeneratedColumn()
  public id: number;

  /**
   * Indexed on its own rather than as part of a composite: every listing this
   * extension serves filters or counts by status ("what is pending?" is the
   * approver's only question), and the owner-scoped listing is small enough that
   * a second index would cost more on write than it saves on read.
   */
  @Column({ type: 'integer' })
  @Index()
  public status: RemovalRequestStatusValue;

  @Column({ type: 'integer' })
  public mediaId: number;

  /**
   * Which variant to remove. Part of the row's identity, not a detail: 4K and
   * non-4K live on separate Radarr/Sonarr servers, so removing one leaves the
   * other alone, and two open requests for the same title are legitimate as long
   * as they name different variants.
   */
  @Column({ type: 'boolean', default: false })
  public is4k: boolean;

  /**
   * `'movie' | 'tv'`, copied off the media at insert.
   *
   * Denormalized on purpose. Without a relation there is no join available for a
   * "show me pending TV removals" filter, and re-reading each row's media through
   * `sdk.media.get` to answer that would be one query per row.
   */
  @Column({ type: 'varchar' })
  public mediaType: 'movie' | 'tv';

  @Column({ type: 'integer' })
  public requestedById: number;

  /**
   * Who approved or declined it. Null until someone does — including on the
   * auto-approval-by-setting path, where nobody decided and attributing it to the
   * requester would misreport who authorized a deletion.
   */
  @Column({ type: 'integer', nullable: true })
  public modifiedById?: number | null;

  @DbAwareColumn({ type: 'datetime' })
  public createdAt: Date;

  @DbAwareColumn({ type: 'datetime' })
  public updatedAt: Date;

  constructor(init?: Partial<RemovalRequest>) {
    Object.assign(this, init);
  }
}
