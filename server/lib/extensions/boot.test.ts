import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import dataSource from '@server/datasource';
import type Media from '@server/entity/Media';
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
  getExtensionPermissionDeclarations,
  setExtensionPermissionDeclarations,
} from '@server/lib/extensions/permissions';
import type { ExtensionRegistry } from '@server/lib/extensions/registry';
import { setupTestDb } from '@server/test/db';

setupTestDb();

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'seerr-ext-boot-'));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
  setExtensionPermissionDeclarations(() => []);
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
    `module.exports.default = async (sdk) => { ${options.server ?? ''} };`
  );
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
});
