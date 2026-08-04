import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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
import { setupTestDb } from '@server/test/db';

// Saving an APPROVED removal request wakes MediaRemovalRequestSubscriber, which
// would reach for a Radarr server no test environment has and flip the request
// to FAILED. These tests are about the entity's columns and relations; the
// subscriber has its own suite under server/test/subscriber. `removeMediaFromServarr`
// is a module-level arrow const, so mock.method can't touch it.
Object.defineProperty(mediaRemoval, 'removeMediaFromServarr', {
  get() {
    return async () => undefined;
  },
  configurable: true,
});

setupTestDb();

async function createMedia(overrides?: Partial<Media>): Promise<Media> {
  const mediaRepository = getRepository(Media);

  return mediaRepository.save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 550,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
      ...overrides,
    })
  );
}

function getUser(email: string): Promise<User> {
  return getRepository(User).findOneOrFail({ where: { email } });
}

async function createRemovalRequest(
  overrides?: Partial<MediaRemovalRequest>
): Promise<MediaRemovalRequest> {
  const removalRequestRepository = getRepository(MediaRemovalRequest);

  return removalRequestRepository.save(
    new MediaRemovalRequest({
      status: MediaRequestStatus.PENDING,
      media: await createMedia(),
      requestedBy: await getUser('friend@seerr.dev'),
      type: MediaType.MOVIE,
      ...overrides,
    })
  );
}

describe('MediaRemovalRequest', () => {
  it('persists a pending request with its media and requester', async () => {
    const saved = await createRemovalRequest();

    const found = await getRepository(MediaRemovalRequest).findOneOrFail({
      where: { id: saved.id },
    });

    assert.strictEqual(found.status, MediaRequestStatus.PENDING);
    assert.strictEqual(found.type, MediaType.MOVIE);
    assert.strictEqual(found.media.tmdbId, 550);
    assert.strictEqual(found.requestedBy.email, 'friend@seerr.dev');
  });

  it('defaults is4k to false and leaves modifiedBy unset', async () => {
    const saved = await createRemovalRequest();

    const found = await getRepository(MediaRemovalRequest).findOneOrFail({
      where: { id: saved.id },
    });

    assert.strictEqual(found.is4k, false);
    assert.strictEqual(found.modifiedBy, null);
  });

  it('records timestamps on insert', async () => {
    const saved = await createRemovalRequest();

    const found = await getRepository(MediaRemovalRequest).findOneOrFail({
      where: { id: saved.id },
    });

    assert.ok(found.createdAt instanceof Date);
    assert.ok(found.updatedAt instanceof Date);
  });

  it('records the approver in modifiedBy', async () => {
    const admin = await getUser('admin@seerr.dev');
    const saved = await createRemovalRequest();

    const removalRequestRepository = getRepository(MediaRemovalRequest);
    saved.status = MediaRequestStatus.APPROVED;
    saved.modifiedBy = admin;
    await removalRequestRepository.save(saved);

    const found = await removalRequestRepository.findOneOrFail({
      where: { id: saved.id },
    });

    assert.strictEqual(found.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(found.modifiedBy?.email, 'admin@seerr.dev');
  });

  it('is deleted along with its media', async () => {
    const media = await createMedia({ tmdbId: 680 });
    const saved = await createRemovalRequest({ media });

    await getRepository(Media).remove(media);

    assert.strictEqual(
      await getRepository(MediaRemovalRequest).findOne({
        where: { id: saved.id },
      }),
      null
    );
  });

  it('is deleted along with its requester', async () => {
    const requestedBy = await getUser('friend@seerr.dev');
    const saved = await createRemovalRequest({ requestedBy });

    await getRepository(User).remove(requestedBy);

    assert.strictEqual(
      await getRepository(MediaRemovalRequest).findOne({
        where: { id: saved.id },
      }),
      null
    );
  });

  it('survives deletion of the user recorded in modifiedBy', async () => {
    const admin = await getUser('admin@seerr.dev');
    const saved = await createRemovalRequest({
      status: MediaRequestStatus.APPROVED,
      modifiedBy: admin,
    });

    await getRepository(User).remove(admin);

    const found = await getRepository(MediaRemovalRequest).findOneOrFail({
      where: { id: saved.id },
    });

    assert.strictEqual(found.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(found.modifiedBy, null);
  });

  it('is reachable from its media through the inverse relation', async () => {
    const media = await createMedia({ tmdbId: 13 });
    await createRemovalRequest({ media, is4k: true });

    const found = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
      relations: { removalRequests: true },
    });

    assert.strictEqual(found.removalRequests.length, 1);
    assert.strictEqual(found.removalRequests[0].is4k, true);
  });
});
