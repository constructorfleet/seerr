import TheMovieDb from '@server/api/themoviedb';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import notificationManager, { Notification } from '@server/lib/notifications';
import logger from '@server/logger';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import { truncate } from 'lodash';
import {
  AfterInsert,
  AfterUpdate,
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

  @AfterInsert()
  public async notifyNewRemovalRequest(): Promise<void> {
    if (this.status !== MediaRequestStatus.PENDING) {
      return;
    }

    const media = await this.loadMedia();

    if (media) {
      MediaRemovalRequest.sendNotification(
        this,
        media,
        Notification.MEDIA_REMOVAL_PENDING
      );
    }
  }

  /**
   * Only checked on update so that auto-approved requests, which are already
   * APPROVED at insert, go through {@link autoapprovalNotification} instead and
   * are announced as automatic.
   */
  @AfterUpdate()
  public async notifyApprovedOrDeclined(autoApproved = false): Promise<void> {
    if (
      this.status !== MediaRequestStatus.APPROVED &&
      this.status !== MediaRequestStatus.DECLINED
    ) {
      return;
    }

    const media = await this.loadMedia();

    if (!media) {
      return;
    }

    MediaRemovalRequest.sendNotification(
      this,
      media,
      this.status === MediaRequestStatus.APPROVED
        ? autoApproved
          ? Notification.MEDIA_REMOVAL_AUTO_APPROVED
          : Notification.MEDIA_REMOVAL_APPROVED
        : Notification.MEDIA_REMOVAL_DECLINED
    );
  }

  @AfterInsert()
  public async autoapprovalNotification(): Promise<void> {
    if (this.status === MediaRequestStatus.APPROVED) {
      await this.notifyApprovedOrDeclined(true);
    }
  }

  private async loadMedia(): Promise<Media | null> {
    const media = await getRepository(Media).findOne({
      where: { id: this.media.id },
    });

    if (!media) {
      logger.error('Media data not found', {
        label: 'Media Removal Request',
        removalRequestId: this.id,
        mediaId: this.media.id,
      });
    }

    return media;
  }

  static async sendNotification(
    entity: MediaRemovalRequest,
    media: Media,
    type: Notification
  ) {
    const tmdb = new TheMovieDb();

    try {
      const mediaType = entity.type === MediaType.MOVIE ? 'Movie' : 'Series';
      const quality = entity.is4k ? '4K ' : '';
      let event: string | undefined;
      // Removals the user asked for are reported back to them; a new pending
      // removal is for whoever can approve it.
      let notifyAdmin = false;

      switch (type) {
        case Notification.MEDIA_REMOVAL_PENDING:
          event = `New ${quality}${mediaType} Removal Request`;
          notifyAdmin = true;
          break;
        case Notification.MEDIA_REMOVAL_APPROVED:
          event = `${quality}${mediaType} Removal Request Approved`;
          break;
        case Notification.MEDIA_REMOVAL_AUTO_APPROVED:
          event = `${quality}${mediaType} Removal Request Automatically Approved`;
          notifyAdmin = true;
          break;
        case Notification.MEDIA_REMOVAL_DECLINED:
          event = `${quality}${mediaType} Removal Request Declined`;
          break;
      }

      const { title, year, overview, posterPath } =
        entity.type === MediaType.MOVIE
          ? await tmdb.getMovie({ movieId: media.tmdbId }).then((movie) => ({
              title: movie.title,
              year: movie.release_date?.slice(0, 4),
              overview: movie.overview,
              posterPath: movie.poster_path,
            }))
          : await tmdb.getTvShow({ tvId: media.tmdbId }).then((tv) => ({
              title: tv.name,
              year: tv.first_air_date?.slice(0, 4),
              overview: tv.overview,
              posterPath: tv.poster_path,
            }));

      notificationManager.sendNotification(type, {
        media,
        removalRequest: entity,
        notifyAdmin,
        notifySystem: true,
        notifyUser: notifyAdmin ? undefined : entity.requestedBy,
        event,
        subject: `${title}${year ? ` (${year})` : ''}`,
        message: truncate(overview, {
          length: 500,
          separator: /\s/,
          omission: '…',
        }),
        image: `https://image.tmdb.org/t/p/w600_and_h900_bestv2${posterPath}`,
      });
    } catch (e) {
      logger.error(
        'Something went wrong sending media removal notification(s)',
        {
          label: 'Notifications',
          errorMessage: e.message,
          removalRequestId: entity.id,
          mediaId: entity.media.id,
        }
      );
    }
  }
}

export default MediaRemovalRequest;
