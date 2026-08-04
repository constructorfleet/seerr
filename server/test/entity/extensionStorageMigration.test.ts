import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import dataSource, { getRepository } from '@server/datasource';
import { ExtensionKv } from '@server/entity/ExtensionKv';
import { ExtensionNotificationSubscription } from '@server/entity/ExtensionNotificationSubscription';
import { ExtensionPermission } from '@server/entity/ExtensionPermission';
import { User } from '@server/entity/User';
import { NotificationAgentKey } from '@server/lib/settings';
import { seedTestDb } from '@server/utils/seedTestDb';

// Builds the schema from the migration files rather than from the entity
// metadata, so a table shape that drifts from the entities is caught here
// rather than in production.
describe('extension storage migration', () => {
  before(async () => {
    await seedTestDb({ withMigrations: true });
  });

  after(async () => {
    // Leave the shared in-memory database in the synchronized state the rest
    // of the suite expects.
    await seedTestDb();
  });

  it('creates the core extension tables', async () => {
    const queryRunner = dataSource.createQueryRunner();

    for (const name of [
      'ext_permission',
      'ext_notification_subscription',
      'ext_kv',
    ]) {
      assert.ok(
        await queryRunner.getTable(name),
        `expected the migrations to create ${name}`
      );
    }
  });

  it('creates every ext_permission column the entity maps', async () => {
    const table = await dataSource
      .createQueryRunner()
      .getTable('ext_permission');

    assert.deepStrictEqual(
      Object.fromEntries(
        (table?.columns ?? []).map((column) => [column.name, column.isNullable])
      ),
      { userId: false, permission: false }
    );
  });

  it('keys ext_permission on the user and the permission', async () => {
    const table = await dataSource
      .createQueryRunner()
      .getTable('ext_permission');

    assert.deepStrictEqual(
      (table?.columns ?? [])
        .filter((column) => column.isPrimary)
        .map((column) => column.name)
        .sort(),
      ['permission', 'userId']
    );
  });

  it('indexes the ext_permission columns lookups filter on', async () => {
    const table = await dataSource
      .createQueryRunner()
      .getTable('ext_permission');

    assert.deepStrictEqual(
      (table?.indices ?? []).flatMap((index) => index.columnNames).sort(),
      ['permission', 'userId']
    );
  });

  it('cascades ext_permission rows from the user', async () => {
    const table = await dataSource
      .createQueryRunner()
      .getTable('ext_permission');

    assert.deepStrictEqual(
      (table?.foreignKeys ?? []).map((fk) => [
        fk.columnNames.join(','),
        fk.referencedTableName,
        fk.onDelete?.toUpperCase(),
      ]),
      [['userId', 'user', 'CASCADE']]
    );
  });

  it('creates every ext_notification_subscription column the entity maps', async () => {
    const table = await dataSource
      .createQueryRunner()
      .getTable('ext_notification_subscription');

    assert.deepStrictEqual(
      Object.fromEntries(
        (table?.columns ?? []).map((column) => [column.name, column.isNullable])
      ),
      { userId: false, notificationType: false, agents: true }
    );
  });

  it('keys ext_notification_subscription on the user and the type', async () => {
    const table = await dataSource
      .createQueryRunner()
      .getTable('ext_notification_subscription');

    assert.deepStrictEqual(
      (table?.columns ?? [])
        .filter((column) => column.isPrimary)
        .map((column) => column.name)
        .sort(),
      ['notificationType', 'userId']
    );
  });

  it('cascades ext_notification_subscription rows from the user', async () => {
    const table = await dataSource
      .createQueryRunner()
      .getTable('ext_notification_subscription');

    assert.deepStrictEqual(
      (table?.foreignKeys ?? []).map((fk) => [
        fk.columnNames.join(','),
        fk.referencedTableName,
        fk.onDelete?.toUpperCase(),
      ]),
      [['userId', 'user', 'CASCADE']]
    );
  });

  it('creates every ext_kv column the entity maps', async () => {
    const table = await dataSource.createQueryRunner().getTable('ext_kv');

    assert.deepStrictEqual(
      Object.fromEntries(
        (table?.columns ?? []).map((column) => [column.name, column.isNullable])
      ),
      {
        extensionId: false,
        key: false,
        value: true,
        createdAt: false,
        updatedAt: false,
      }
    );
  });

  it('keys ext_kv on the extension and the key', async () => {
    const table = await dataSource.createQueryRunner().getTable('ext_kv');

    assert.deepStrictEqual(
      (table?.columns ?? [])
        .filter((column) => column.isPrimary)
        .map((column) => column.name)
        .sort(),
      ['extensionId', 'key']
    );
  });

  it('indexes ext_kv by extension', async () => {
    const table = await dataSource.createQueryRunner().getTable('ext_kv');

    assert.deepStrictEqual(
      (table?.indices ?? []).flatMap((index) => index.columnNames),
      ['extensionId']
    );
  });

  it('accepts rows written through the entities', async () => {
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    await getRepository(ExtensionPermission).save(
      new ExtensionPermission({
        userId: user.id,
        permission: 'unrequest:remove_own',
      })
    );
    await getRepository(ExtensionNotificationSubscription).save(
      new ExtensionNotificationSubscription({
        userId: user.id,
        notificationType: 'watch-history:milestone',
        agents: [NotificationAgentKey.DISCORD],
      })
    );
    await getRepository(ExtensionKv).save(
      new ExtensionKv({
        extensionId: 'watch-history',
        key: 'lastSync',
        value: { count: 1 },
      })
    );

    assert.strictEqual(
      (
        await getRepository(ExtensionPermission).findOneOrFail({
          where: { userId: user.id },
        })
      ).permission,
      'unrequest:remove_own'
    );
    assert.deepStrictEqual(
      (
        await getRepository(ExtensionNotificationSubscription).findOneOrFail({
          where: { userId: user.id },
        })
      ).agents,
      ['discord']
    );
    assert.deepStrictEqual(
      (
        await getRepository(ExtensionKv).findOneOrFail({
          where: { extensionId: 'watch-history', key: 'lastSync' },
        })
      ).value,
      { count: 1 }
    );
  });
});
