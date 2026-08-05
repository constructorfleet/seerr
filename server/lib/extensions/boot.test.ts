import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import dataSource, { getRepository } from '@server/datasource';
import type Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { scheduledJobs } from '@server/job/schedule';
import {
  activateDiscoveredExtensions,
  discoverExtensionsForBoot,
} from '@server/lib/extensions/boot';
import {
  clearExtensionEventSource,
  emitExtensionEvent,
} from '@server/lib/extensions/events';
import {
  getExtensionNotificationDeclarations,
  setExtensionNotificationDeclarations,
  subscribeExtensionNotification,
} from '@server/lib/extensions/notifications';
import {
  getExtensionPermissionDeclarations,
  setExtensionPermissionDeclarations,
} from '@server/lib/extensions/permissions';
import type { ExtensionRegistry } from '@server/lib/extensions/registry';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import { setupTestDb } from '@server/test/db';
import { DataSource } from 'typeorm';

setupTestDb();

/**
 * Fixture extensions are `require()`d as plain CommonJS from a temp directory, so
 * they cannot resolve Seerr's `node_modules` by name — `typeorm` goes in as an
 * absolute path.
 */
const TYPEORM_PATH = require.resolve('typeorm');

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'seerr-ext-boot-'));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
  setExtensionPermissionDeclarations(() => []);
  setExtensionNotificationDeclarations(() => []);
  clearExtensionEventSource();

  for (const job of scheduledJobs.splice(0, scheduledJobs.length)) {
    job.job.cancel();
  }
});

interface WriteOptions {
  /** Overrides the generated manifest wholesale. */
  manifest?: Record<string, unknown>;
  /** The body of the entry point's default export. */
  server?: string;
  /**
   * Prepended to the entry point at module scope, for the exports discovery reads
   * before the DataSource exists — `entities` and `migrations`.
   */
  moduleScope?: string;
}

async function writeExtension(
  id: string,
  options: WriteOptions = {}
): Promise<void> {
  const extensionDirectory = path.join(directory, id);
  await fs.mkdir(extensionDirectory, { recursive: true });

  await fs.writeFile(
    path.join(extensionDirectory, 'seerr-extension.json'),
    JSON.stringify(
      options.manifest ?? {
        id,
        name: id,
        version: '1.0.0',
        apiVersion: '^1.0.0',
        server: 'index.js',
      }
    )
  );
  await fs.writeFile(
    path.join(extensionDirectory, 'index.js'),
    `${options.moduleScope ?? ''}
module.exports.default = async (sdk) => { ${options.server ?? ''} };`
  );
}

/** An `EntitySchema` entity, which needs no decorators and so works in plain JS. */
function entitySource(body: string): string {
  return `const { EntitySchema } = require(${JSON.stringify(TYPEORM_PATH)});
module.exports.entities = [new EntitySchema(${body})];
`;
}

/** A well-formed entity: one table in the extension's namespace, with a key. */
function goodEntity(tableName: string): string {
  return entitySource(`{
    name: ${JSON.stringify(tableName)},
    tableName: ${JSON.stringify(tableName)},
    columns: { id: { primary: true, type: 'integer', generated: true } },
  }`);
}

/**
 * A stand-in for `server/index.ts`'s DataSource: the entities are injected into
 * it before `initialize()`, exactly as boot does, so these tests fail the way a
 * real boot fails rather than the way a mock does. Separate from the shared test
 * DataSource because injecting a broken entity into that one would poison every
 * later test in the file.
 */
function bootDataSource(): DataSource {
  return new DataSource({
    type: 'sqlite',
    database: ':memory:',
    synchronize: true,
    dropSchema: true,
    entities: ['server/entity/**/*.ts'],
  });
}

/**
 * The test DataSource has `synchronize: true`, so boot must not run extension
 * migrations against it — see `ActivateExtensionsOptions.runMigrations`. Passing
 * the real DataSource is what exercises that decision.
 */
function activate(registry: ExtensionRegistry): Promise<void> {
  return activateDiscoveredExtensions(registry, dataSource);
}

describe('extension boot wiring', () => {
  it('discovers and activates an extension', async () => {
    await writeExtension('demo');

    const registry = await discoverExtensionsForBoot({ directory });
    await activate(registry);

    assert.deepStrictEqual(registry.health(), [
      { id: 'demo', name: 'demo', version: '1.0.0', status: 'active' },
    ]);
  });

  it('returns an empty registry when nothing is installed', async () => {
    const registry = await discoverExtensionsForBoot({ directory });
    await activate(registry);

    assert.deepStrictEqual(registry.all(), []);
  });

  it('does not reject when the extensions directory is absent', async () => {
    const registry = await discoverExtensionsForBoot({
      directory: path.join(directory, 'nope'),
    });
    await activate(registry);

    assert.deepStrictEqual(registry.all(), []);
  });

  it('quarantines an extension whose entry point throws, and boots', async () => {
    await writeExtension('broken', {
      server: 'throw new Error("setup exploded");',
    });
    await writeExtension('demo');

    const registry = await discoverExtensionsForBoot({ directory });
    await activate(registry);

    assert.deepStrictEqual(
      registry.health().map((entry) => [entry.id, entry.status] as const),
      [
        ['broken', 'failed'],
        ['demo', 'active'],
      ]
    );
  });

  it('quarantines an extension with an invalid manifest, and boots', async () => {
    await writeExtension('broken', {
      manifest: { id: 'broken', name: 'broken' },
    });
    await writeExtension('demo');

    const registry = await discoverExtensionsForBoot({ directory });
    await activate(registry);

    assert.deepStrictEqual(
      registry.health().map((entry) => [entry.id, entry.status] as const),
      [
        ['broken', 'failed'],
        ['demo', 'active'],
      ]
    );
  });

  it('points the permission resolver at the activated extensions', async () => {
    await writeExtension('demo', {
      manifest: {
        id: 'demo',
        name: 'demo',
        version: '1.0.0',
        apiVersion: '^1.0.0',
        server: 'index.js',
        provides: {
          permissions: [{ key: 'view_own', name: 'View Own', default: true }],
        },
      },
    });

    const registry = await discoverExtensionsForBoot({ directory });
    await activate(registry);

    assert.deepStrictEqual(
      getExtensionPermissionDeclarations().map(
        (declaration) => declaration.permission
      ),
      ['demo:view_own']
    );
  });

  it('declares no permissions for an extension that failed to activate', async () => {
    await writeExtension('broken', {
      manifest: {
        id: 'broken',
        name: 'broken',
        version: '1.0.0',
        apiVersion: '^1.0.0',
        server: 'index.js',
        provides: {
          permissions: [{ key: 'view_own', name: 'View Own' }],
        },
      },
      server: 'throw new Error("setup exploded");',
    });

    const registry = await discoverExtensionsForBoot({ directory });
    await activate(registry);

    assert.deepStrictEqual(getExtensionPermissionDeclarations(), []);
  });

  it('schedules the jobs an activated extension registered', async () => {
    await writeExtension('demo', {
      manifest: {
        id: 'demo',
        name: 'demo',
        version: '1.0.0',
        apiVersion: '^1.0.0',
        server: 'index.js',
        requires: { jobs: true },
        provides: {
          jobs: [{ id: 'sync', name: 'Sync', schedule: '0 * * * * *' }],
        },
      },
      server: 'sdk.jobs.register("sync", async () => {});',
    });

    const registry = await discoverExtensionsForBoot({ directory });
    await activate(registry);

    assert.deepStrictEqual(
      scheduledJobs.map((job) => job.id),
      ['demo:sync']
    );
  });

  it('schedules no jobs for an extension that failed to activate', async () => {
    await writeExtension('broken', {
      manifest: {
        id: 'broken',
        name: 'broken',
        version: '1.0.0',
        apiVersion: '^1.0.0',
        server: 'index.js',
        requires: { jobs: true },
        provides: {
          jobs: [{ id: 'sync', name: 'Sync', schedule: '0 * * * * *' }],
        },
      },
      server:
        'sdk.jobs.register("sync", async () => {}); throw new Error("setup exploded");',
    });

    const registry = await discoverExtensionsForBoot({ directory });
    await activate(registry);

    assert.deepStrictEqual(scheduledJobs, []);
  });

  it('makes the activated extensions the event source', async () => {
    await writeExtension('demo', {
      server:
        'sdk.events.on("media.available", () => { global.__extBootSeen = true; });',
    });

    const registry = await discoverExtensionsForBoot({ directory });
    await activate(registry);

    await emitExtensionEvent('media.available', {
      media: {} as Media,
      is4k: false,
    });

    assert.strictEqual((global as Record<string, unknown>).__extBootSeen, true);
    delete (global as Record<string, unknown>).__extBootSeen;
  });

  it('points the notification resolver at the activated extensions', async () => {
    await writeExtension('demo', {
      manifest: {
        id: 'demo',
        name: 'demo',
        version: '1.0.0',
        apiVersion: '^1.0.0',
        server: 'index.js',
        provides: {
          notifications: [
            { key: 'milestone', name: 'Milestone', default: true },
          ],
        },
      },
    });

    const registry = await discoverExtensionsForBoot({ directory });
    await activate(registry);

    assert.deepStrictEqual(
      getExtensionNotificationDeclarations().map(
        (declaration) => declaration.notificationType
      ),
      ['demo:milestone']
    );
  });

  it('declares no notifications for an extension that failed to activate', async () => {
    await writeExtension('broken', {
      manifest: {
        id: 'broken',
        name: 'broken',
        version: '1.0.0',
        apiVersion: '^1.0.0',
        server: 'index.js',
        provides: {
          notifications: [{ key: 'milestone', name: 'Milestone' }],
        },
      },
      server: 'throw new Error("setup exploded");',
    });

    const registry = await discoverExtensionsForBoot({ directory });
    await activate(registry);

    assert.deepStrictEqual(getExtensionNotificationDeclarations(), []);
  });

  it('delivers sdk.notify.send through the notification manager', async () => {
    await writeExtension('demo', {
      manifest: {
        id: 'demo',
        name: 'demo',
        version: '1.0.0',
        apiVersion: '^1.0.0',
        server: 'index.js',
        provides: {
          notifications: [{ key: 'milestone', name: 'Milestone' }],
        },
      },
      // Notifying from the entry point is the case that forces the resolver to be
      // wired before activation rather than after it.
      server: 'await sdk.notify.send("milestone", { subject: "Hello" });',
    });

    const friend = await getRepository(User).findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    await subscribeExtensionNotification(friend.id, 'demo:milestone');

    const dispatched: [Notification, number | undefined][] = [];
    const sent = mock.method(
      notificationManager,
      'sendNotification',
      (type: Notification, payload: NotificationPayload) => {
        dispatched.push([type, payload.notifyUser?.id]);
      }
    );

    try {
      const registry = await discoverExtensionsForBoot({ directory });
      await activate(registry);
    } finally {
      sent.mock.restore();
    }

    assert.deepStrictEqual(dispatched, [
      [Notification.EXTENSION, undefined],
      [Notification.EXTENSION, friend.id],
    ]);
  });
});

/**
 * `collectEntities` only checks that an entity names a table inside the
 * extension's namespace. An entity that passes that and is still invalid to
 * TypeORM's metadata builder — no primary column, a relation to a target that
 * does not exist — used to throw out of `dataSource.initialize()`, which
 * `server/index.ts` does not guard: one bad extension, and Seerr does not boot at
 * all, with no way back through the admin UI because the server never listens.
 *
 * See docs/specs/extension-system.md: "must not prevent Seerr from starting".
 */
describe('extension entity validation at boot', () => {
  let target: DataSource;

  afterEach(async () => {
    if (target?.isInitialized) {
      await target.destroy();
    }
  });

  it('quarantines an entity with no primary column, and boots', async () => {
    await writeExtension('broken', {
      moduleScope: entitySource(`{
        name: 'ext_broken_thing',
        tableName: 'ext_broken_thing',
        columns: { label: { type: 'varchar' } },
      }`),
    });

    target = bootDataSource();
    const registry = await discoverExtensionsForBoot({
      directory,
      dataSource: target,
    });

    await target.initialize();

    const [health] = registry.health();
    assert.strictEqual(health.status, 'failed');
    assert.match(health.error ?? '', /primary column/i);
    assert.deepStrictEqual(registry.entities, []);
  });

  it('quarantines an entity whose relation target does not exist, and boots', async () => {
    await writeExtension('broken', {
      moduleScope: entitySource(`{
        name: 'ext_broken_thing',
        tableName: 'ext_broken_thing',
        columns: { id: { primary: true, type: 'integer', generated: true } },
        relations: {
          owner: { type: 'many-to-one', target: 'NoSuchEntity' },
        },
      }`),
    });

    target = bootDataSource();
    const registry = await discoverExtensionsForBoot({
      directory,
      dataSource: target,
    });

    await target.initialize();

    const [health] = registry.health();
    assert.strictEqual(health.status, 'failed');
    assert.deepStrictEqual(registry.entities, []);
  });

  it('names the offending extension in the operator-visible reason', async () => {
    await writeExtension('broken', {
      moduleScope: entitySource(`{
        name: 'ext_broken_thing',
        tableName: 'ext_broken_thing',
        columns: { label: { type: 'varchar' } },
      }`),
    });

    target = bootDataSource();
    const registry = await discoverExtensionsForBoot({
      directory,
      dataSource: target,
    });
    await target.initialize();

    // `health()` is what the admin UI reads, so the reason has to survive into it
    // rather than only reaching the log.
    assert.deepStrictEqual(
      registry.health().map((entry) => entry.id),
      ['broken']
    );
    assert.match(registry.health()[0].error ?? '', /ext_broken_thing/);
  });

  it('keeps a good extension loading, and its table working, beside a bad one', async () => {
    await writeExtension('broken', {
      moduleScope: entitySource(`{
        name: 'ext_broken_thing',
        tableName: 'ext_broken_thing',
        columns: { label: { type: 'varchar' } },
      }`),
    });
    await writeExtension('demo', { moduleScope: goodEntity('ext_demo_event') });

    target = bootDataSource();
    const registry = await discoverExtensionsForBoot({
      directory,
      dataSource: target,
    });
    await target.initialize();

    assert.deepStrictEqual(
      registry.health().map((entry) => [entry.id, entry.status] as const),
      [
        ['broken', 'failed'],
        ['demo', 'pending'],
      ]
    );

    // `synchronize: true` created the good extension's table from the entity that
    // survived injection, so a round-trip proves the surviving entity is really
    // mapped and not merely present in the options.
    const repository = target.getRepository('ext_demo_event');
    const saved = await repository.save({});
    assert.deepStrictEqual(await repository.find(), [saved]);
  });

  it('injects nothing rather than failing when no extension has entities', async () => {
    await writeExtension('demo');

    target = bootDataSource();
    const registry = await discoverExtensionsForBoot({
      directory,
      dataSource: target,
    });
    await target.initialize();

    assert.strictEqual(registry.get('demo')?.status, 'pending');
  });
});
