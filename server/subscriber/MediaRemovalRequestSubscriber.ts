import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRemovalRequest from '@server/entity/MediaRemovalRequest';
import { removeMediaFromServarr } from '@server/lib/mediaRemoval';
import { Notification } from '@server/lib/notifications';
import logger from '@server/logger';
import type {
  EntitySubscriberInterface,
  InsertEvent,
  UpdateEvent,
} from 'typeorm';
import { EventSubscriber } from 'typeorm';

/**
 * Carries out approved removal requests: deletes the media from Radarr/Sonarr
 * and flags the media row (and its seasons) as deleted.
 */
@EventSubscriber()
export class MediaRemovalRequestSubscriber implements EntitySubscriberInterface<MediaRemovalRequest> {
  private async processRemoval(entity: MediaRemovalRequest): Promise<void> {
    if (entity.status !== MediaRequestStatus.APPROVED) {
      return;
    }

    const mediaRepository = getRepository(Media);

    // Re-read so the removal works from the current media state, and so the
    // seasons relation is loaded for series.
    const media = await mediaRepository.findOne({
      where: { id: entity.media.id },
      relations: { seasons: true },
    });

    if (!media) {
      throw new Error('Media data not found');
    }

    try {
      await removeMediaFromServarr(media, entity.is4k);
      await mediaRepository.save(media);

      logger.info('Removed media for approved removal request', {
        label: 'Media Removal Request',
        removalRequestId: entity.id,
        mediaId: media.id,
        is4k: entity.is4k,
      });
    } catch (e) {
      logger.warn(
        'Something went wrong removing media, marking removal request as FAILED',
        {
          label: 'Media Removal Request',
          removalRequestId: entity.id,
          mediaId: media.id,
          is4k: entity.is4k,
          errorMessage: e instanceof Error ? e.message : String(e),
        }
      );

      // Saving from inside the subscriber re-enters afterUpdate, but FAILED is
      // not APPROVED so processRemoval bails immediately.
      entity.status = MediaRequestStatus.FAILED;
      await getRepository(MediaRemovalRequest).save(entity);

      MediaRemovalRequest.sendNotification(
        entity,
        media,
        Notification.MEDIA_FAILED
      );
    }
  }

  public async afterInsert(
    event: InsertEvent<MediaRemovalRequest>
  ): Promise<void> {
    if (!event.entity) {
      return;
    }

    await this.guard(event.entity);
  }

  public async afterUpdate(
    event: UpdateEvent<MediaRemovalRequest>
  ): Promise<void> {
    if (!event.entity) {
      return;
    }

    await this.guard(event.entity as MediaRemovalRequest);
  }

  /** A subscriber must never throw past the save that triggered it. */
  private async guard(entity: MediaRemovalRequest): Promise<void> {
    try {
      await this.processRemoval(entity);
    } catch (e) {
      logger.error('Error while processing an approved removal request', {
        label: 'Media Removal Request',
        removalRequestId: entity.id,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }

  public listenTo(): typeof MediaRemovalRequest {
    return MediaRemovalRequest;
  }
}
