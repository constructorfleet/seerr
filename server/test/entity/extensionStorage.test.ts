import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getRepository } from '@server/datasource';
import { ExtensionKv } from '@server/entity/ExtensionKv';
import { ExtensionNotificationSubscription } from '@server/entity/ExtensionNotificationSubscription';
import { ExtensionPermission } from '@server/entity/ExtensionPermission';
import { User } from '@server/entity/User';
import { NotificationAgentKey } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

setupTestDb();

function getUser(email: string): Promise<User> {
  return getRepository(User).findOneOrFail({ where: { email } });
}

describe('ExtensionPermission', () => {
  it('persists a namespaced permission for a user', async () => {
    const user = await getUser('friend@seerr.dev');
    const repository = getRepository(ExtensionPermission);

    await repository.save(
      new ExtensionPermission({
        userId: user.id,
        permission: 'unrequest:remove_own',
      })
    );

    const found = await repository.findOneOrFail({
      where: { userId: user.id, permission: 'unrequest:remove_own' },
    });

    assert.strictEqual(found.userId, user.id);
    assert.strictEqual(found.permission, 'unrequest:remove_own');
  });

  it('keys rows by user and permission together', async () => {
    const user = await getUser('friend@seerr.dev');
    const repository = getRepository(ExtensionPermission);

    await repository.save([
      new ExtensionPermission({ userId: user.id, permission: 'a:one' }),
      new ExtensionPermission({ userId: user.id, permission: 'a:two' }),
    ]);

    assert.strictEqual(await repository.countBy({ userId: user.id }), 2);
  });

  it('rejects the same permission twice for one user', async () => {
    const user = await getUser('friend@seerr.dev');
    const repository = getRepository(ExtensionPermission);

    await repository.insert({ userId: user.id, permission: 'a:one' });

    await assert.rejects(() =>
      repository.insert({ userId: user.id, permission: 'a:one' })
    );
  });

  it('grants the same permission key to different users independently', async () => {
    const repository = getRepository(ExtensionPermission);
    const admin = await getUser('admin@seerr.dev');
    const friend = await getUser('friend@seerr.dev');

    await repository.save([
      new ExtensionPermission({ userId: admin.id, permission: 'a:one' }),
      new ExtensionPermission({ userId: friend.id, permission: 'a:one' }),
    ]);

    assert.strictEqual(await repository.countBy({ permission: 'a:one' }), 2);
  });

  it('is deleted along with its user', async () => {
    const friend = await getUser('friend@seerr.dev');
    const repository = getRepository(ExtensionPermission);

    await repository.save(
      new ExtensionPermission({ userId: friend.id, permission: 'a:one' })
    );

    await getRepository(User).remove(friend);

    assert.strictEqual(await repository.countBy({ userId: friend.id }), 0);
  });

  it('leaves other users rows in place when one user is deleted', async () => {
    const admin = await getUser('admin@seerr.dev');
    const friend = await getUser('friend@seerr.dev');
    const repository = getRepository(ExtensionPermission);

    await repository.save([
      new ExtensionPermission({ userId: admin.id, permission: 'a:one' }),
      new ExtensionPermission({ userId: friend.id, permission: 'a:one' }),
    ]);

    await getRepository(User).remove(friend);

    assert.strictEqual(await repository.countBy({ userId: admin.id }), 1);
  });

  it('loads the user through its relation', async () => {
    const friend = await getUser('friend@seerr.dev');
    const repository = getRepository(ExtensionPermission);

    await repository.save(
      new ExtensionPermission({ userId: friend.id, permission: 'a:one' })
    );

    const found = await repository.findOneOrFail({
      where: { userId: friend.id },
      relations: { user: true },
    });

    assert.strictEqual(found.user?.email, 'friend@seerr.dev');
  });
});

describe('ExtensionNotificationSubscription', () => {
  it('round-trips the subscribed agents as a JSON array', async () => {
    const user = await getUser('friend@seerr.dev');
    const repository = getRepository(ExtensionNotificationSubscription);

    await repository.save(
      new ExtensionNotificationSubscription({
        userId: user.id,
        notificationType: 'watch-history:milestone',
        agents: [NotificationAgentKey.DISCORD, NotificationAgentKey.WEBPUSH],
      })
    );

    const found = await repository.findOneOrFail({
      where: { userId: user.id, notificationType: 'watch-history:milestone' },
    });

    assert.deepStrictEqual(found.agents, ['discord', 'webpush']);
  });

  it('reads an empty subscription back as an empty array', async () => {
    const user = await getUser('friend@seerr.dev');
    const repository = getRepository(ExtensionNotificationSubscription);

    await repository.save(
      new ExtensionNotificationSubscription({
        userId: user.id,
        notificationType: 'watch-history:milestone',
        agents: [],
      })
    );

    const found = await repository.findOneOrFail({
      where: { userId: user.id, notificationType: 'watch-history:milestone' },
    });

    assert.deepStrictEqual(found.agents, []);
  });

  it('replaces the agent list on update', async () => {
    const user = await getUser('friend@seerr.dev');
    const repository = getRepository(ExtensionNotificationSubscription);

    await repository.save(
      new ExtensionNotificationSubscription({
        userId: user.id,
        notificationType: 'watch-history:milestone',
        agents: [NotificationAgentKey.DISCORD],
      })
    );
    await repository.save(
      new ExtensionNotificationSubscription({
        userId: user.id,
        notificationType: 'watch-history:milestone',
        agents: [NotificationAgentKey.EMAIL],
      })
    );

    const found = await repository.findOneOrFail({
      where: { userId: user.id, notificationType: 'watch-history:milestone' },
    });

    assert.deepStrictEqual(found.agents, ['email']);
    assert.strictEqual(await repository.countBy({ userId: user.id }), 1);
  });

  it('keys rows by user and notification type together', async () => {
    const user = await getUser('friend@seerr.dev');
    const repository = getRepository(ExtensionNotificationSubscription);

    await repository.insert({
      userId: user.id,
      notificationType: 'watch-history:milestone',
      agents: [],
    });

    await assert.rejects(() =>
      repository.insert({
        userId: user.id,
        notificationType: 'watch-history:milestone',
        agents: [],
      })
    );
  });

  it('is deleted along with its user', async () => {
    const friend = await getUser('friend@seerr.dev');
    const repository = getRepository(ExtensionNotificationSubscription);

    await repository.save(
      new ExtensionNotificationSubscription({
        userId: friend.id,
        notificationType: 'watch-history:milestone',
        agents: [NotificationAgentKey.DISCORD],
      })
    );

    await getRepository(User).remove(friend);

    assert.strictEqual(await repository.countBy({ userId: friend.id }), 0);
  });
});

describe('ExtensionKv', () => {
  it('round-trips a JSON value', async () => {
    const repository = getRepository(ExtensionKv);

    await repository.save(
      new ExtensionKv({
        extensionId: 'watch-history',
        key: 'lastSync',
        value: { at: '2026-01-01T00:00:00.000Z', count: 3 },
      })
    );

    const found = await repository.findOneOrFail({
      where: { extensionId: 'watch-history', key: 'lastSync' },
    });

    assert.deepStrictEqual(found.value, {
      at: '2026-01-01T00:00:00.000Z',
      count: 3,
    });
  });

  it('round-trips non-object JSON values', async () => {
    const repository = getRepository(ExtensionKv);

    await repository.save([
      new ExtensionKv({ extensionId: 'a', key: 'number', value: 42 }),
      new ExtensionKv({ extensionId: 'a', key: 'string', value: 'hello' }),
      new ExtensionKv({ extensionId: 'a', key: 'false', value: false }),
      new ExtensionKv({ extensionId: 'a', key: 'array', value: [1, 2] }),
      new ExtensionKv({ extensionId: 'a', key: 'null', value: null }),
    ]);

    const found = await repository.find({
      where: { extensionId: 'a' },
      order: { key: 'ASC' },
    });

    assert.deepStrictEqual(
      found.map((row) => [row.key, row.value]),
      [
        ['array', [1, 2]],
        ['false', false],
        ['null', null],
        ['number', 42],
        ['string', 'hello'],
      ]
    );
  });

  it('scopes keys to an extension', async () => {
    const repository = getRepository(ExtensionKv);

    await repository.save([
      new ExtensionKv({ extensionId: 'a', key: 'shared', value: 1 }),
      new ExtensionKv({ extensionId: 'b', key: 'shared', value: 2 }),
    ]);

    const found = await repository.findOneOrFail({
      where: { extensionId: 'b', key: 'shared' },
    });

    assert.strictEqual(found.value, 2);
    assert.strictEqual(await repository.count(), 2);
  });

  it('rejects the same key twice for one extension', async () => {
    const repository = getRepository(ExtensionKv);

    await repository.insert({ extensionId: 'a', key: 'shared', value: 1 });

    await assert.rejects(() =>
      repository.insert({ extensionId: 'a', key: 'shared', value: 2 })
    );
  });

  it('overwrites a value on save', async () => {
    const repository = getRepository(ExtensionKv);

    await repository.save(
      new ExtensionKv({ extensionId: 'a', key: 'shared', value: 1 })
    );
    await repository.save(
      new ExtensionKv({ extensionId: 'a', key: 'shared', value: { now: 2 } })
    );

    const found = await repository.findOneOrFail({
      where: { extensionId: 'a', key: 'shared' },
    });

    assert.deepStrictEqual(found.value, { now: 2 });
    assert.strictEqual(await repository.count(), 1);
  });

  it('records timestamps', async () => {
    const repository = getRepository(ExtensionKv);

    await repository.save(
      new ExtensionKv({ extensionId: 'a', key: 'shared', value: 1 })
    );

    const found = await repository.findOneOrFail({
      where: { extensionId: 'a', key: 'shared' },
    });

    assert.ok(found.createdAt instanceof Date);
    assert.ok(found.updatedAt instanceof Date);
  });
});
