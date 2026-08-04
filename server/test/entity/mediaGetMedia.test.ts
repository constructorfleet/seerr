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
import { setupTestDb } from '@server/test/db';

setupTestDb();

async function createMedia(): Promise<Media> {
  return getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 550,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
    })
  );
}

describe('Media.getMedia', () => {
  it('loads removal requests so the client can see pending removals', async () => {
    const media = await createMedia();

    await getRepository(MediaRemovalRequest).save(
      new MediaRemovalRequest({
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: await getRepository(User).findOneOrFail({
          where: { email: 'friend@seerr.dev' },
        }),
        type: MediaType.MOVIE,
      })
    );

    const found = await Media.getMedia(550, MediaType.MOVIE);

    assert.ok(found, 'expected the media to be found');
    assert.strictEqual(found?.removalRequests.length, 1);
    assert.strictEqual(
      found?.removalRequests[0].status,
      MediaRequestStatus.PENDING
    );
    assert.strictEqual(
      found?.removalRequests[0].requestedBy.email,
      'friend@seerr.dev'
    );
  });

  it('returns an empty removal request list when there are none', async () => {
    await createMedia();

    const found = await Media.getMedia(550, MediaType.MOVIE);

    assert.deepStrictEqual(found?.removalRequests, []);
  });

  it('still loads requests and issues', async () => {
    await createMedia();

    const found = await Media.getMedia(550, MediaType.MOVIE);

    assert.deepStrictEqual(found?.requests, []);
    assert.deepStrictEqual(found?.issues, []);
  });
});
