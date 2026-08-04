import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRemovalRequest from '@server/entity/MediaRemovalRequest';
import { User } from '@server/entity/User';
import * as mediaRemoval from '@server/lib/mediaRemoval';
import { Notification } from '@server/lib/notifications';
import { setupTestDb } from '@server/test/db';

// `removeMediaFromServarr` is a module-level const arrow function, so it is
// swapped through the module namespace descriptor rather than mock.method.
const removeCalls: { mediaId: number; is4k: boolean }[] = [];
let removeImpl: (media: Media, is4k: boolean) => Promise<void> = async (
  media,
  is4k
) => {
  media[is4k ? 'status4k' : 'status'] = MediaStatus.DELETED;
};

Object.defineProperty(mediaRemoval, 'removeMediaFromServarr', {
  get() {
    return async (media: Media, is4k: boolean) => {
      removeCalls.push({ mediaId: media.id, is4k });
      return removeImpl(media, is4k);
    };
  },
  set() {},
  configurable: true,
});

const sentNotifications: Notification[] = [];

Object.defineProperty(MediaRemovalRequest, 'sendNotification', {
  get() {
    return async (
      _entity: MediaRemovalRequest,
      _media: Media,
      type: Notification
    ) => {
      sentNotifications.push(type);
    };
  },
  set() {},
  configurable: true,
});

async function seed(
  status: MediaRequestStatus,
  mediaStatus = MediaStatus.AVAILABLE,
  is4k = false
): Promise<MediaRemovalRequest> {
  const media = await getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 550,
      status: is4k ? MediaStatus.UNKNOWN : mediaStatus,
      status4k: is4k ? mediaStatus : MediaStatus.UNKNOWN,
    })
  );

  return getRepository(MediaRemovalRequest).save(
    new MediaRemovalRequest({
      status,
      media,
      requestedBy: await getRepository(User).findOneOrFail({
        where: { email: 'friend@seerr.dev' },
      }),
      type: MediaType.MOVIE,
      is4k,
    })
  );
}

describe('MediaRemovalRequestSubscriber', () => {
  setupTestDb();

  beforeEach(() => {
    removeCalls.length = 0;
    sentNotifications.length = 0;
    removeImpl = async (media, is4k) => {
      media[is4k ? 'status4k' : 'status'] = MediaStatus.DELETED;
    };
  });

  it('removes the media when a removal request is inserted already approved', async () => {
    const removalRequest = await seed(MediaRequestStatus.APPROVED);

    assert.deepStrictEqual(removeCalls, [
      { mediaId: removalRequest.media.id, is4k: false },
    ]);
  });

  it('removes the media when a pending request is approved', async () => {
    const repository = getRepository(MediaRemovalRequest);
    const removalRequest = await seed(MediaRequestStatus.PENDING);

    assert.deepStrictEqual(removeCalls, []);

    removalRequest.status = MediaRequestStatus.APPROVED;
    await repository.save(removalRequest);

    assert.deepStrictEqual(removeCalls, [
      { mediaId: removalRequest.media.id, is4k: false },
    ]);
  });

  it('persists the deleted media status', async () => {
    const removalRequest = await seed(MediaRequestStatus.APPROVED);

    const media = await getRepository(Media).findOneOrFail({
      where: { id: removalRequest.media.id },
    });

    assert.strictEqual(media.status, MediaStatus.DELETED);
  });

  it('removes only the 4K variant for a 4K removal request', async () => {
    const removalRequest = await seed(
      MediaRequestStatus.APPROVED,
      MediaStatus.AVAILABLE,
      true
    );

    assert.deepStrictEqual(removeCalls, [
      { mediaId: removalRequest.media.id, is4k: true },
    ]);

    const media = await getRepository(Media).findOneOrFail({
      where: { id: removalRequest.media.id },
    });

    assert.strictEqual(media.status4k, MediaStatus.DELETED);
    assert.strictEqual(media.status, MediaStatus.UNKNOWN);
  });

  it('does not remove media for a declined request', async () => {
    const repository = getRepository(MediaRemovalRequest);
    const removalRequest = await seed(MediaRequestStatus.PENDING);

    removalRequest.status = MediaRequestStatus.DECLINED;
    await repository.save(removalRequest);

    assert.deepStrictEqual(removeCalls, []);
  });

  it('marks the request FAILED and notifies when removal throws', async () => {
    removeImpl = async () => {
      throw new Error('Radarr is unreachable');
    };

    const removalRequest = await seed(MediaRequestStatus.APPROVED);

    const persisted = await getRepository(MediaRemovalRequest).findOneOrFail({
      where: { id: removalRequest.id },
    });

    assert.strictEqual(persisted.status, MediaRequestStatus.FAILED);
    assert.ok(
      sentNotifications.includes(Notification.MEDIA_FAILED),
      'expected a MEDIA_FAILED notification'
    );
  });

  it('leaves the media untouched when removal throws', async () => {
    removeImpl = async () => {
      throw new Error('Radarr is unreachable');
    };

    const removalRequest = await seed(MediaRequestStatus.APPROVED);

    const media = await getRepository(Media).findOneOrFail({
      where: { id: removalRequest.media.id },
    });

    assert.strictEqual(media.status, MediaStatus.AVAILABLE);
  });

  it('does not retry removal for a request that already failed', async () => {
    const repository = getRepository(MediaRemovalRequest);
    const removalRequest = await seed(MediaRequestStatus.PENDING);

    removalRequest.status = MediaRequestStatus.FAILED;
    await repository.save(removalRequest);

    assert.deepStrictEqual(removeCalls, []);
  });
});
