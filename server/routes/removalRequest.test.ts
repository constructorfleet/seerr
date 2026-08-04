import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRemovalRequest from '@server/entity/MediaRemovalRequest';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import * as mediaRemoval from '@server/lib/mediaRemoval';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import removalRequestRoutes from './removalRequest';

const sendNotificationMock = mock.method(
  MediaRemovalRequest,
  'sendNotification',
  async () => undefined
).mock;

// These tests cover the HTTP surface only. Approving a removal wakes
// MediaRemovalRequestSubscriber, which would otherwise reach for a Radarr
// server that no test environment has and flip the request to FAILED — the
// subscriber's own behaviour is covered in
// server/test/subscriber/MediaRemovalRequestSubscriber.test.ts.
// `removeMediaFromServarr` is a module-level arrow const, so mock.method can't
// touch it; redefine the export instead.
Object.defineProperty(mediaRemoval, 'removeMediaFromServarr', {
  get() {
    return async () => undefined;
  },
  configurable: true,
});

let app: Express;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/removal', removalRequestRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

before(() => {
  app = createApp();
});

beforeEach(() => {
  sendNotificationMock.resetCalls();
  getSettings().main.autoApproveRemovalWhenUnavailable = false;
});

setupTestDb();

async function loginAs(email: string, password = 'test1234') {
  const settings = getSettings();
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent.post('/auth/local').send({ email, password });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
}

/** Grants extra permissions to the non-admin `friend` user. */
async function grantFriend(...permissions: Permission[]): Promise<User> {
  const userRepository = getRepository(User);
  const friend = await userRepository.findOneOrFail({
    where: { email: 'friend@seerr.dev' },
  });

  friend.permissions = permissions.reduce(
    (total, permission) => total + permission,
    Permission.REQUEST
  );

  return userRepository.save(friend);
}

interface SeedOptions {
  mediaStatus?: MediaStatus;
  requesterEmail?: string;
  requestStatus?: MediaRequestStatus;
  /** Skip creating the original addition request entirely. */
  withoutRequest?: boolean;
  tmdbId?: number;
  is4k?: boolean;
}

async function seedMedia({
  mediaStatus = MediaStatus.AVAILABLE,
  requesterEmail = 'friend@seerr.dev',
  requestStatus = MediaRequestStatus.COMPLETED,
  withoutRequest = false,
  tmdbId = 550,
  is4k = false,
}: SeedOptions = {}): Promise<Media> {
  const media = await getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId,
      status: is4k ? MediaStatus.UNKNOWN : mediaStatus,
      status4k: is4k ? mediaStatus : MediaStatus.UNKNOWN,
    })
  );

  if (!withoutRequest) {
    await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: requestStatus,
        media,
        requestedBy: await getRepository(User).findOneOrFail({
          where: { email: requesterEmail },
        }),
        is4k,
      })
    );
  }

  return media;
}

async function seedRemovalRequest(
  overrides: Partial<MediaRemovalRequest> = {}
): Promise<MediaRemovalRequest> {
  const media = overrides.media ?? (await seedMedia());

  return getRepository(MediaRemovalRequest).save(
    new MediaRemovalRequest({
      status: MediaRequestStatus.PENDING,
      requestedBy:
        overrides.requestedBy ??
        (await getRepository(User).findOneOrFail({
          where: { email: 'friend@seerr.dev' },
        })),
      type: MediaType.MOVIE,
      is4k: false,
      ...overrides,
      media,
    })
  );
}

describe('GET /removal/count', () => {
  it('counts removal requests by status', async () => {
    await seedRemovalRequest();
    await seedRemovalRequest({
      media: await seedMedia({ tmdbId: 551 }),
      status: MediaRequestStatus.APPROVED,
    });
    await seedRemovalRequest({
      media: await seedMedia({ tmdbId: 552 }),
      status: MediaRequestStatus.DECLINED,
    });

    const agent = await loginAs('admin@seerr.dev');
    const res = await agent.get('/removal/count');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, {
      total: 3,
      movie: 3,
      tv: 0,
      pending: 1,
      approved: 1,
      declined: 1,
      failed: 0,
      completed: 0,
    });
  });

  it('is not shadowed by the :removalRequestId route', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const res = await agent.get('/removal/count');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.total, 0);
  });
});

describe('POST /removal', () => {
  it('rejects a user without the REQUEST_REMOVE permission', async () => {
    const media = await seedMedia();
    await grantFriend();

    const agent = await loginAs('friend@seerr.dev');
    const res = await agent.post('/removal').send({ mediaId: media.id });

    assert.strictEqual(res.status, 403);
  });

  it('creates a pending removal request for the requester', async () => {
    const media = await seedMedia();
    await grantFriend(Permission.REQUEST_REMOVE);

    const agent = await loginAs('friend@seerr.dev');
    const res = await agent.post('/removal').send({ mediaId: media.id });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.status, MediaRequestStatus.PENDING);
    assert.strictEqual(res.body.requestedBy.email, 'friend@seerr.dev');
    assert.strictEqual(res.body.is4k, false);
    assert.strictEqual(res.body.type, MediaType.MOVIE);
  });

  it('rejects a user who never requested the media', async () => {
    const media = await seedMedia({ requesterEmail: 'admin@seerr.dev' });
    await grantFriend(Permission.REQUEST_REMOVE);

    const agent = await loginAs('friend@seerr.dev');
    const res = await agent.post('/removal').send({ mediaId: media.id });

    assert.strictEqual(res.status, 403);
  });

  it('lets an approver remove media they never requested', async () => {
    const media = await seedMedia({ withoutRequest: true });

    const agent = await loginAs('admin@seerr.dev');
    const res = await agent.post('/removal').send({ mediaId: media.id });

    assert.strictEqual(res.status, 201);
  });

  it('rejects a duplicate pending removal request', async () => {
    const existing = await seedRemovalRequest();
    await grantFriend(Permission.REQUEST_REMOVE);

    const agent = await loginAs('friend@seerr.dev');
    const res = await agent
      .post('/removal')
      .send({ mediaId: existing.media.id });

    assert.strictEqual(res.status, 409);
  });

  it('allows a new removal request once the prior one was declined', async () => {
    const declined = await seedRemovalRequest({
      status: MediaRequestStatus.DECLINED,
    });
    await grantFriend(Permission.REQUEST_REMOVE);

    const agent = await loginAs('friend@seerr.dev');
    const res = await agent
      .post('/removal')
      .send({ mediaId: declined.media.id });

    assert.strictEqual(res.status, 201);
  });

  it('rejects removal of media that is already deleted', async () => {
    const media = await seedMedia({ mediaStatus: MediaStatus.DELETED });
    await grantFriend(Permission.REQUEST_REMOVE);

    const agent = await loginAs('friend@seerr.dev');
    const res = await agent.post('/removal').send({ mediaId: media.id });

    assert.strictEqual(res.status, 400);
  });

  it('returns 404 for unknown media', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const res = await agent.post('/removal').send({ mediaId: 99999 });

    assert.strictEqual(res.status, 404);
  });

  it('auto-approves for a user who can manage requests', async () => {
    const media = await seedMedia({ withoutRequest: true });

    const agent = await loginAs('admin@seerr.dev');
    const res = await agent.post('/removal').send({ mediaId: media.id });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.status, MediaRequestStatus.APPROVED);
  });

  it('auto-approves unavailable media when the setting is on', async () => {
    getSettings().main.autoApproveRemovalWhenUnavailable = true;
    const media = await seedMedia({
      mediaStatus: MediaStatus.PROCESSING,
      requestStatus: MediaRequestStatus.APPROVED,
    });
    await grantFriend(Permission.REQUEST_REMOVE);

    const agent = await loginAs('friend@seerr.dev');
    const res = await agent.post('/removal').send({ mediaId: media.id });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.status, MediaRequestStatus.APPROVED);
  });

  it('does not auto-approve available media when the setting is on', async () => {
    getSettings().main.autoApproveRemovalWhenUnavailable = true;
    const media = await seedMedia({ mediaStatus: MediaStatus.AVAILABLE });
    await grantFriend(Permission.REQUEST_REMOVE);

    const agent = await loginAs('friend@seerr.dev');
    const res = await agent.post('/removal').send({ mediaId: media.id });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.status, MediaRequestStatus.PENDING);
  });

  it('scopes the 4K variant separately from the non-4K one', async () => {
    const media = await seedMedia({ is4k: true });
    await grantFriend(Permission.REQUEST_REMOVE);

    const agent = await loginAs('friend@seerr.dev');

    // The user only requested the 4K variant, so only that one is removable.
    const non4k = await agent.post('/removal').send({ mediaId: media.id });
    assert.strictEqual(non4k.status, 403);

    const res4k = await agent
      .post('/removal')
      .send({ mediaId: media.id, is4k: true });
    assert.strictEqual(res4k.status, 201);
    assert.strictEqual(res4k.body.is4k, true);
  });
});

describe('GET /removal', () => {
  it('limits a user without view permissions to their own requests', async () => {
    const admin = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    await seedRemovalRequest();
    await seedRemovalRequest({
      media: await seedMedia({ tmdbId: 551 }),
      requestedBy: admin,
    });
    await grantFriend(Permission.REQUEST_REMOVE);

    const agent = await loginAs('friend@seerr.dev');
    const res = await agent.get('/removal');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.results.length, 1);
    assert.strictEqual(
      res.body.results[0].requestedBy.email,
      'friend@seerr.dev'
    );
  });

  it('returns every request to an approver', async () => {
    const admin = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    await seedRemovalRequest();
    await seedRemovalRequest({
      media: await seedMedia({ tmdbId: 551 }),
      requestedBy: admin,
    });

    const agent = await loginAs('admin@seerr.dev');
    const res = await agent.get('/removal');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.results.length, 2);
    assert.strictEqual(res.body.pageInfo.results, 2);
  });

  it('filters to pending requests', async () => {
    await seedRemovalRequest();
    await seedRemovalRequest({
      media: await seedMedia({ tmdbId: 551 }),
      status: MediaRequestStatus.DECLINED,
    });

    const agent = await loginAs('admin@seerr.dev');
    const res = await agent.get('/removal?filter=pending');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.results.length, 1);
    assert.strictEqual(res.body.results[0].status, MediaRequestStatus.PENDING);
  });

  it('rejects a request to view another user’s removal requests', async () => {
    await grantFriend(Permission.REQUEST_REMOVE);

    const agent = await loginAs('friend@seerr.dev');
    const res = await agent.get('/removal?requestedBy=1');

    assert.strictEqual(res.status, 403);
  });
});

describe('GET /removal/:removalRequestId', () => {
  it('returns the request to its owner', async () => {
    const removalRequest = await seedRemovalRequest();
    await grantFriend(Permission.REQUEST_REMOVE);

    const agent = await loginAs('friend@seerr.dev');
    const res = await agent.get(`/removal/${removalRequest.id}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id, removalRequest.id);
  });

  it('hides another user’s request from a user without view permissions', async () => {
    const removalRequest = await seedRemovalRequest({
      requestedBy: await getRepository(User).findOneOrFail({
        where: { email: 'admin@seerr.dev' },
      }),
    });
    await grantFriend(Permission.REQUEST_REMOVE);

    const agent = await loginAs('friend@seerr.dev');
    const res = await agent.get(`/removal/${removalRequest.id}`);

    assert.strictEqual(res.status, 403);
  });

  it('returns 404 for an unknown request', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const res = await agent.get('/removal/99999');

    assert.strictEqual(res.status, 404);
  });
});

describe('POST /removal/:removalRequestId/:status', () => {
  const cases = [
    { action: 'approve', expected: MediaRequestStatus.APPROVED },
    { action: 'decline', expected: MediaRequestStatus.DECLINED },
    { action: 'pending', expected: MediaRequestStatus.PENDING },
  ] as const;

  for (const { action, expected } of cases) {
    it(`transitions to ${action} and records the acting user`, async () => {
      const removalRequest = await seedRemovalRequest({
        status:
          action === 'pending'
            ? MediaRequestStatus.DECLINED
            : MediaRequestStatus.PENDING,
      });

      const agent = await loginAs('admin@seerr.dev');
      const res = await agent.post(`/removal/${removalRequest.id}/${action}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, expected);
      assert.strictEqual(res.body.modifiedBy.email, 'admin@seerr.dev');

      const persisted = await getRepository(MediaRemovalRequest).findOneOrFail({
        where: { id: removalRequest.id },
      });
      assert.strictEqual(persisted.status, expected);
    });
  }

  it('rejects an unknown status with 400 rather than writing undefined', async () => {
    const removalRequest = await seedRemovalRequest();

    const agent = await loginAs('admin@seerr.dev');
    const res = await agent.post(`/removal/${removalRequest.id}/bogus`);

    assert.strictEqual(res.status, 400);

    const persisted = await getRepository(MediaRemovalRequest).findOneOrFail({
      where: { id: removalRequest.id },
    });
    assert.strictEqual(persisted.status, MediaRequestStatus.PENDING);
  });

  it('rejects a user who cannot manage requests', async () => {
    const removalRequest = await seedRemovalRequest();
    await grantFriend(Permission.REQUEST_REMOVE);

    const agent = await loginAs('friend@seerr.dev');
    const res = await agent.post(`/removal/${removalRequest.id}/approve`);

    assert.strictEqual(res.status, 403);
  });
});

describe('DELETE /removal/:removalRequestId', () => {
  it('lets the owner withdraw a pending request', async () => {
    const removalRequest = await seedRemovalRequest();
    await grantFriend(Permission.REQUEST_REMOVE);

    const agent = await loginAs('friend@seerr.dev');
    const res = await agent.delete(`/removal/${removalRequest.id}`);

    assert.strictEqual(res.status, 204);
    assert.strictEqual(
      await getRepository(MediaRemovalRequest).countBy({
        id: removalRequest.id,
      }),
      0
    );
  });

  it('prevents the owner from withdrawing an approved request', async () => {
    const removalRequest = await seedRemovalRequest({
      status: MediaRequestStatus.APPROVED,
    });
    await grantFriend(Permission.REQUEST_REMOVE);

    const agent = await loginAs('friend@seerr.dev');
    const res = await agent.delete(`/removal/${removalRequest.id}`);

    assert.strictEqual(res.status, 403);
  });

  it('lets an approver delete any request', async () => {
    const removalRequest = await seedRemovalRequest({
      status: MediaRequestStatus.APPROVED,
    });

    const agent = await loginAs('admin@seerr.dev');
    const res = await agent.delete(`/removal/${removalRequest.id}`);

    assert.strictEqual(res.status, 204);
  });

  it('returns 404 for an unknown request', async () => {
    const agent = await loginAs('admin@seerr.dev');
    const res = await agent.delete('/removal/99999');

    assert.strictEqual(res.status, 404);
  });
});
