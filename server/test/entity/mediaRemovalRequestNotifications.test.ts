import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRemovalRequest from '@server/entity/MediaRemovalRequest';
import { User } from '@server/entity/User';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import { setupTestDb } from '@server/test/db';

interface SentNotification {
  type: Notification;
  payload: NotificationPayload;
}

const sent: SentNotification[] = [];

// `sendNotification` and the TMDB lookups are instance methods on the
// prototype, but arrow-function properties elsewhere in the repo can't be
// mocked with mock.method — use the accessor pattern uniformly.
function stub<T>(
  proto: object,
  name: string,
  impl: T
): { restore: () => void } {
  const original = Object.getOwnPropertyDescriptor(proto, name);
  Object.defineProperty(proto, name, {
    get() {
      return impl;
    },
    set() {
      /* entity assignment is a no-op while stubbed */
    },
    configurable: true,
  });

  return {
    restore: () => {
      if (original) {
        Object.defineProperty(proto, name, original);
      } else {
        delete (proto as Record<string, unknown>)[name];
      }
    },
  };
}

const restores: { restore: () => void }[] = [];

async function createMedia(status = MediaStatus.AVAILABLE): Promise<Media> {
  return getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 550,
      status,
      status4k: MediaStatus.UNKNOWN,
    })
  );
}

async function friend(): Promise<User> {
  return getRepository(User).findOneOrFail({
    where: { email: 'friend@seerr.dev' },
  });
}

describe('MediaRemovalRequest notifications', () => {
  setupTestDb();

  before(() => {
    restores.push(
      stub(
        notificationManager,
        'sendNotification',
        (type: Notification, payload: NotificationPayload) => {
          sent.push({ type, payload });
        }
      ),
      stub(TheMovieDb.prototype, 'getMovie', async () => ({
        title: 'Fight Club',
        release_date: '1999-10-15',
        overview: 'A ticking-time-bomb insomniac.',
        poster_path: '/poster.jpg',
      })),
      stub(TheMovieDb.prototype, 'getTvShow', async () => ({
        name: 'Test Show',
        first_air_date: '2020-01-01',
        overview: 'A show.',
        poster_path: '/poster.jpg',
      }))
    );
  });

  after(() => {
    for (const entry of restores) {
      entry.restore();
    }
  });

  beforeEach(() => {
    sent.length = 0;
  });

  it('notifies of a pending removal request on insert', async () => {
    const media = await createMedia();

    await getRepository(MediaRemovalRequest).save(
      new MediaRemovalRequest({
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: await friend(),
        type: MediaType.MOVIE,
      })
    );

    const notification = sent.find(
      (entry) => entry.type === Notification.MEDIA_REMOVAL_PENDING
    );

    assert.ok(notification, 'expected a MEDIA_REMOVAL_PENDING notification');
    assert.ok(
      notification?.payload.removalRequest,
      'the payload should carry the removal request'
    );
    assert.strictEqual(notification?.payload.request, undefined);
    assert.strictEqual(notification?.payload.notifyAdmin, true);
    assert.match(notification?.payload.event ?? '', /Removal Request/);
  });

  it('notifies of an auto-approved removal request on insert', async () => {
    const media = await createMedia();

    await getRepository(MediaRemovalRequest).save(
      new MediaRemovalRequest({
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: await friend(),
        type: MediaType.MOVIE,
      })
    );

    assert.ok(
      sent.some(
        (entry) => entry.type === Notification.MEDIA_REMOVAL_AUTO_APPROVED
      ),
      'expected a MEDIA_REMOVAL_AUTO_APPROVED notification'
    );
    assert.ok(
      !sent.some((entry) => entry.type === Notification.MEDIA_REMOVAL_PENDING),
      'an auto-approved removal should not also notify as pending'
    );
  });

  it('notifies of an approval on update', async () => {
    const repository = getRepository(MediaRemovalRequest);
    const request = await repository.save(
      new MediaRemovalRequest({
        status: MediaRequestStatus.PENDING,
        media: await createMedia(),
        requestedBy: await friend(),
        type: MediaType.MOVIE,
      })
    );

    sent.length = 0;
    request.status = MediaRequestStatus.APPROVED;
    await repository.save(request);

    const notification = sent.find(
      (entry) => entry.type === Notification.MEDIA_REMOVAL_APPROVED
    );

    assert.ok(notification, 'expected a MEDIA_REMOVAL_APPROVED notification');
    // The requester asked for this, so it goes to them rather than to approvers.
    assert.strictEqual(notification?.payload.notifyAdmin, false);
    assert.strictEqual(
      notification?.payload.notifyUser?.email,
      'friend@seerr.dev'
    );
  });

  it('notifies of a decline on update', async () => {
    const repository = getRepository(MediaRemovalRequest);
    const request = await repository.save(
      new MediaRemovalRequest({
        status: MediaRequestStatus.PENDING,
        media: await createMedia(),
        requestedBy: await friend(),
        type: MediaType.MOVIE,
      })
    );

    sent.length = 0;
    request.status = MediaRequestStatus.DECLINED;
    await repository.save(request);

    assert.ok(
      sent.some((entry) => entry.type === Notification.MEDIA_REMOVAL_DECLINED),
      'expected a MEDIA_REMOVAL_DECLINED notification'
    );
  });

  it('marks the 4K variant in the event text', async () => {
    await getRepository(MediaRemovalRequest).save(
      new MediaRemovalRequest({
        status: MediaRequestStatus.PENDING,
        media: await createMedia(),
        requestedBy: await friend(),
        type: MediaType.MOVIE,
        is4k: true,
      })
    );

    const notification = sent.find(
      (entry) => entry.type === Notification.MEDIA_REMOVAL_PENDING
    );

    assert.match(notification?.payload.event ?? '', /^New 4K Movie/);
  });

  it('sends nothing while the request stays pending', async () => {
    const repository = getRepository(MediaRemovalRequest);
    const request = await repository.save(
      new MediaRemovalRequest({
        status: MediaRequestStatus.PENDING,
        media: await createMedia(),
        requestedBy: await friend(),
        type: MediaType.MOVIE,
      })
    );

    sent.length = 0;
    request.is4k = false;
    await repository.save(request);

    assert.deepStrictEqual(sent, []);
  });
});
