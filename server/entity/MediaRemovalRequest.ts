import type { MediaRequestStatus, MediaType } from '@server/constants/media';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import Media from './Media';
import { User } from './User';

/**
 * A request to remove media the user previously requested — an "unrequest".
 *
 * Modeled on {@link MediaRequest} and sharing its `MediaRequestStatus` state
 * machine, but kept in its own table: a great deal of code queries
 * `media_request` with no notion of a request type, and would silently treat
 * removal requests as additions (quota accounting, the pending badge count,
 * the subscriber that pushes requests to Radarr/Sonarr, and more).
 *
 * Removal is scoped per title per 4K variant. Sonarr exposes no per-season
 * delete, so there is deliberately no seasons relation here.
 */
@Entity()
class MediaRemovalRequest {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'integer' })
  @Index()
  public status: MediaRequestStatus;

  @ManyToOne(() => Media, (media) => media.removalRequests, {
    eager: true,
    onDelete: 'CASCADE',
  })
  @Index()
  public media: Media;

  @ManyToOne(() => User, {
    eager: true,
    onDelete: 'CASCADE',
  })
  @Index()
  public requestedBy: User;

  /** The user who approved or declined the request, if anyone has. */
  @ManyToOne(() => User, {
    nullable: true,
    eager: true,
    onDelete: 'SET NULL',
  })
  @Index()
  public modifiedBy?: User | null;

  @Column({ default: false })
  public is4k: boolean;

  @Column({ type: 'varchar' })
  public type: MediaType;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<MediaRemovalRequest>) {
    Object.assign(this, init);
  }
}

export default MediaRemovalRequest;
