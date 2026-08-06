import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { getRepository } from '@server/datasource';
import { ExtensionKv } from '@server/entity/ExtensionKv';
import { User } from '@server/entity/User';
import {
  HOST_API_VERSION,
  activateExtensions,
  discoverExtensions,
  injectExtensionEntities,
} from '@server/lib/extensions/loader';
import type { ExtensionSdk } from '@server/lib/extensions/types';
import logger from '@server/logger';
import { setupTestDb } from '@server/test/db';
import type { DataSourceOptions } from 'typeorm';
import { DataSource } from 'typeorm';

setupTestDb();

/**
 * Fixture extensions are written to a temp directory and `require()`d as plain
 * CommonJS, so they cannot resolve Seerr's `node_modules` by name — anything
 * they need is injected as an absolute path.
 */
const TYPEORM_PATH = require.resolve('typeorm');

interface Recorder {
  /** Extension ids whose entry point ran, in order. */
  activated: string[];
  /** Extension ids whose module was `require()`d, in order. */
  imported: string[];
  /** The SDK each extension was handed, for gating assertions. */
  sdks: Record<string, ExtensionSdk>;
}

declare global {
  var __seerrExtensionTest: Recorder | undefined;
}

function recorder(): Recorder {
  return (globalThis.__seerrExtensionTest ??= {
    activated: [],
    imported: [],
    sdks: {},
  });
}

// Injected into every fixture module so it can report back synchronously.
const RECORD_PREAMBLE = `const record = (globalThis.__seerrExtensionTest ??= { activated: [], imported: [], sdks: {} });`;

/** A CommonJS entry point that records its SDK, then runs `body`. */
function entryPoint(body = ''): string {
  return `${RECORD_PREAMBLE}
module.exports.default = async (sdk) => {
  record.activated.push(sdk.id);
  record.sdks[sdk.id] = sdk;
  ${body}
};
`;
}

/** An `EntitySchema` entity, which needs no decorators and so works in plain JS. */
function entitySource(tableName: string): string {
  return `const { EntitySchema } = require(${JSON.stringify(TYPEORM_PATH)});
module.exports.entities = [
  new EntitySchema({
    name: ${JSON.stringify(tableName)},
    tableName: ${JSON.stringify(tableName)},
    columns: { id: { primary: true, type: 'integer', generated: true } },
  }),
];
`;
}

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'seerr-ext-loader-'));
  globalThis.__seerrExtensionTest = undefined;
});

afterEach(async () => {
  globalThis.__seerrExtensionTest = undefined;
  await fs.rm(directory, { recursive: true, force: true });
});

interface FixtureOptions {
  /** Overrides merged into the default manifest. `null` omits the file. */
  manifest?: Record<string, unknown> | null;
  /** Written verbatim as the manifest, for testing unparseable JSON. */
  rawManifest?: string;
  /** Source of the file named by `server`. `null` omits the file. */
  server?: string | null;
  /** Extra files, keyed by path relative to the extension directory. */
  files?: Record<string, string>;
  /** Directory name, when it must differ from the manifest `id`. */
  dirname?: string;
}

async function writeExtension(
  id: string,
  options: FixtureOptions = {}
): Promise<string> {
  const extensionDirectory = path.join(directory, options.dirname ?? id);
  await fs.mkdir(extensionDirectory, { recursive: true });

  if (options.rawManifest !== undefined) {
    await fs.writeFile(
      path.join(extensionDirectory, 'seerr-extension.json'),
      options.rawManifest
    );
  } else if (options.manifest !== null) {
    await fs.writeFile(
      path.join(extensionDirectory, 'seerr-extension.json'),
      JSON.stringify({
        id,
        name: `Extension ${id}`,
        version: '1.0.0',
        apiVersion: '^1.0.0',
        server: 'server.js',
        ...options.manifest,
      })
    );
  }

  if (options.server !== null) {
    await fs.writeFile(
      path.join(extensionDirectory, 'server.js'),
      options.server ?? entryPoint()
    );
  }

  for (const [file, contents] of Object.entries(options.files ?? {})) {
    const target = path.join(extensionDirectory, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }

  return extensionDirectory;
}

/** The `ExtensionSdk` members the manifest `requires` gates. */
const GATED_CAPABILITIES = [
  'store',
  'users',
  'media',
  'requests',
  'discover',
  'settings',
  'jobs',
  'notify',
] as const satisfies readonly (keyof ExtensionSdk)[];

function sdkFor(id: string): ExtensionSdk {
  const sdk = recorder().sdks[id];
  assert.ok(sdk, `expected extension "${id}" to have been activated`);
  return sdk;
}

describe('HOST_API_VERSION', () => {
  it('is the semver version extensions declare compatibility with', () => {
    assert.strictEqual(HOST_API_VERSION, '1.0.0');
  });
});

describe('discoverExtensions', () => {
  it('returns an empty registry when the extensions directory is absent', async () => {
    const registry = await discoverExtensions({
      directory: path.join(directory, 'nonexistent'),
    });

    assert.deepStrictEqual(registry.health(), []);
    assert.deepStrictEqual(registry.entities, []);
  });

  it('returns an empty registry when nothing is installed', async () => {
    const registry = await discoverExtensions({ directory });

    assert.deepStrictEqual(registry.health(), []);
  });

  it('discovers an installed extension', async () => {
    await writeExtension('demo');

    const registry = await discoverExtensions({ directory });

    assert.deepStrictEqual(registry.health(), [
      {
        id: 'demo',
        name: 'Extension demo',
        version: '1.0.0',
        status: 'pending',
      },
    ]);
  });

  it('records the extension directory and manifest', async () => {
    const extensionDirectory = await writeExtension('demo');

    const registry = await discoverExtensions({ directory });
    const entry = registry.get('demo');

    assert.strictEqual(entry?.directory, extensionDirectory);
    assert.strictEqual(entry?.manifest?.id, 'demo');
  });

  it('does not activate the entry point during discovery', async () => {
    await writeExtension('demo');

    await discoverExtensions({ directory });

    assert.deepStrictEqual(recorder().activated, []);
  });

  it('ignores a directory without a manifest', async () => {
    await fs.mkdir(path.join(directory, 'not-an-extension'));

    const registry = await discoverExtensions({ directory });

    assert.deepStrictEqual(registry.health(), []);
  });

  it('ignores a stray file in the extensions directory', async () => {
    await fs.writeFile(path.join(directory, 'README.md'), '# not an extension');

    const registry = await discoverExtensions({ directory });

    assert.deepStrictEqual(registry.health(), []);
  });

  it('discovers several extensions, ordered by id', async () => {
    await writeExtension('beta');
    await writeExtension('alpha');

    const registry = await discoverExtensions({ directory });

    assert.deepStrictEqual(
      registry.health().map((health) => health.id),
      ['alpha', 'beta']
    );
  });
});

describe('discoverExtensions quarantine', () => {
  it('quarantines a manifest that is not valid JSON', async () => {
    await writeExtension('demo', { rawManifest: '{ "id": "demo", ' });

    const registry = await discoverExtensions({ directory });
    const [health] = registry.health();

    assert.strictEqual(health.status, 'failed');
    assert.match(health.error ?? '', /JSON/i);
  });

  it('quarantines a manifest that fails validation', async () => {
    await writeExtension('demo', { manifest: { name: '' } });

    const registry = await discoverExtensions({ directory });
    const [health] = registry.health();

    assert.strictEqual(health.status, 'failed');
    assert.match(health.error ?? '', /manifest/i);
  });

  it('quarantines an unreadable manifest', async () => {
    const extensionDirectory = await writeExtension('demo', {
      manifest: null,
    });
    // A directory where the manifest should be: readable entry, unreadable file.
    await fs.mkdir(path.join(extensionDirectory, 'seerr-extension.json'));

    const registry = await discoverExtensions({ directory });
    const [health] = registry.health();

    assert.strictEqual(health.status, 'failed');
    assert.ok(health.error);
  });

  it('rejects an extension whose directory name disagrees with its id', async () => {
    await writeExtension('demo', { dirname: 'renamed' });

    const registry = await discoverExtensions({ directory });
    const [health] = registry.health();

    assert.strictEqual(health.status, 'failed');
    assert.match(health.error ?? '', /renamed/);
    assert.match(health.error ?? '', /demo/);
  });

  it('reports a directory/id mismatch under the directory name', async () => {
    await writeExtension('demo', { dirname: 'renamed' });

    const registry = await discoverExtensions({ directory });

    assert.strictEqual(registry.get('renamed')?.status, 'failed');
    assert.strictEqual(registry.get('demo'), undefined);
  });

  it('quarantines an extension built against an incompatible host api', async () => {
    await writeExtension('demo', { manifest: { apiVersion: '^2.0.0' } });

    const registry = await discoverExtensions({ directory });
    const [health] = registry.health();

    assert.strictEqual(health.status, 'failed');
    assert.match(health.error ?? '', /\^2\.0\.0/);
    assert.match(health.error ?? '', new RegExp(HOST_API_VERSION));
  });

  it('accepts an api version range the host satisfies', async () => {
    await writeExtension('demo', { manifest: { apiVersion: '>=1.0.0 <2' } });

    const registry = await discoverExtensions({ directory });

    assert.strictEqual(registry.get('demo')?.status, 'pending');
  });

  it('quarantines an extension whose entry point is missing', async () => {
    await writeExtension('demo', { server: null });

    const registry = await discoverExtensions({ directory });
    const [health] = registry.health();

    assert.strictEqual(health.status, 'failed');
    assert.match(health.error ?? '', /server\.js/);
  });

  it('quarantines an entry point that throws while being loaded', async () => {
    await writeExtension('demo', {
      server: `throw new Error('exploded on import');`,
    });

    const registry = await discoverExtensions({ directory });
    const [health] = registry.health();

    assert.strictEqual(health.status, 'failed');
    assert.match(health.error ?? '', /exploded on import/);
  });

  it('quarantines an entry point with no default export', async () => {
    await writeExtension('demo', {
      server: `module.exports.setup = () => {};`,
    });

    const registry = await discoverExtensions({ directory });
    const [health] = registry.health();

    assert.strictEqual(health.status, 'failed');
    assert.match(health.error ?? '', /default export/i);
  });

  it('keeps discovering the remaining extensions after one fails', async () => {
    await writeExtension('broken', { rawManifest: 'nope' });
    await writeExtension('demo');

    const registry = await discoverExtensions({ directory });

    assert.deepStrictEqual(
      registry.health().map((health) => [health.id, health.status]),
      [
        ['broken', 'failed'],
        ['demo', 'pending'],
      ]
    );
  });
});

describe('discoverExtensions disabled extensions', () => {
  it('skips a disabled extension', async () => {
    await writeExtension('demo');

    const registry = await discoverExtensions({
      directory,
      isEnabled: () => false,
    });

    assert.strictEqual(registry.get('demo')?.status, 'disabled');
  });

  it('does not load a disabled extension module', async () => {
    await writeExtension('demo', {
      server: `${RECORD_PREAMBLE}
record.imported.push('demo');
throw new Error('should never be imported');`,
    });

    const registry = await discoverExtensions({
      directory,
      isEnabled: () => false,
    });

    assert.deepStrictEqual(recorder().imported, []);
    assert.strictEqual(registry.get('demo')?.status, 'disabled');
  });

  it('loads only the enabled extensions', async () => {
    await writeExtension('on');
    await writeExtension('off');

    const registry = await discoverExtensions({
      directory,
      isEnabled: (id) => id === 'on',
    });

    assert.deepStrictEqual(
      registry.health().map((health) => [health.id, health.status]),
      [
        ['off', 'disabled'],
        ['on', 'pending'],
      ]
    );
  });

  it('does not activate a disabled extension', async () => {
    await writeExtension('demo');

    const registry = await discoverExtensions({
      directory,
      isEnabled: () => false,
    });
    await activateExtensions(registry);

    assert.deepStrictEqual(recorder().activated, []);
    assert.strictEqual(registry.get('demo')?.status, 'disabled');
  });
});

describe('discoverExtensions entities', () => {
  it('collects entity classes from the extension module', async () => {
    await writeExtension('demo', {
      server: `${entitySource('ext_demo_event')}${entryPoint()}`,
    });

    const registry = await discoverExtensions({ directory });

    assert.strictEqual(registry.entities.length, 1);
    assert.deepStrictEqual(registry.get('demo')?.entities, registry.entities);
  });

  it('aggregates entities across extensions', async () => {
    await writeExtension('one', {
      server: `${entitySource('ext_one_event')}${entryPoint()}`,
    });
    await writeExtension('two', {
      server: `${entitySource('ext_two_event')}${entryPoint()}`,
    });

    const registry = await discoverExtensions({ directory });

    assert.strictEqual(registry.entities.length, 2);
  });

  it('collects no entities from an extension that declares none', async () => {
    await writeExtension('demo');

    const registry = await discoverExtensions({ directory });

    assert.deepStrictEqual(registry.entities, []);
  });

  it('quarantines an entity whose table is outside the extension namespace', async () => {
    await writeExtension('demo', {
      server: `${entitySource('user')}${entryPoint()}`,
    });

    const registry = await discoverExtensions({ directory });
    const [health] = registry.health();

    assert.strictEqual(health.status, 'failed');
    assert.match(health.error ?? '', /user/);
    assert.match(health.error ?? '', /ext_demo_/);
    assert.deepStrictEqual(registry.entities, []);
  });

  it('quarantines an entity given as a path instead of a class', async () => {
    await writeExtension('demo', {
      server: `module.exports.entities = ['server/entity/**/*.js'];
${entryPoint()}`,
    });

    const registry = await discoverExtensions({ directory });
    const [health] = registry.health();

    assert.strictEqual(health.status, 'failed');
    assert.deepStrictEqual(registry.entities, []);
  });

  it('keeps a healthy extension entity when a sibling is quarantined', async () => {
    await writeExtension('broken', {
      server: `${entitySource('user')}${entryPoint()}`,
    });
    await writeExtension('demo', {
      server: `${entitySource('ext_demo_event')}${entryPoint()}`,
    });

    const registry = await discoverExtensions({ directory });

    assert.strictEqual(registry.entities.length, 1);
    assert.deepStrictEqual(registry.get('demo')?.entities, registry.entities);
  });
});

describe('injectExtensionEntities', () => {
  it('appends extension entities to the DataSource options', async () => {
    await writeExtension('demo', {
      server: `${entitySource('ext_demo_event')}${entryPoint()}`,
    });
    const registry = await discoverExtensions({ directory });

    const target = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: ['server/entity/**/*.ts'],
    });
    injectExtensionEntities(target, registry);

    assert.deepStrictEqual(target.options.entities, [
      'server/entity/**/*.ts',
      ...registry.entities,
    ]);
  });

  it('leaves the options alone when nothing was discovered', async () => {
    const registry = await discoverExtensions({ directory });

    const target = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: ['server/entity/**/*.ts'],
    });
    injectExtensionEntities(target, registry);

    assert.deepStrictEqual(target.options.entities, ['server/entity/**/*.ts']);
  });
});

describe('activateExtensions', () => {
  it('calls the entry point and marks the extension active', async () => {
    await writeExtension('demo');

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    assert.deepStrictEqual(recorder().activated, ['demo']);
    assert.deepStrictEqual(registry.health(), [
      {
        id: 'demo',
        name: 'Extension demo',
        version: '1.0.0',
        status: 'active',
      },
    ]);
  });

  it('activates extensions one at a time, ordered by id', async () => {
    await writeExtension('beta');
    await writeExtension('alpha');

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    assert.deepStrictEqual(recorder().activated, ['alpha', 'beta']);
  });

  it('awaits an entry point that returns a promise', async () => {
    await writeExtension('demo', {
      server: `${RECORD_PREAMBLE}
module.exports.default = (sdk) =>
  new Promise((resolve) =>
    setTimeout(() => {
      record.activated.push(sdk.id);
      record.sdks[sdk.id] = sdk;
      resolve();
    }, 5)
  );`,
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    assert.deepStrictEqual(recorder().activated, ['demo']);
    assert.strictEqual(registry.get('demo')?.status, 'active');
  });

  it('does nothing when no extension was discovered', async () => {
    const registry = await discoverExtensions({ directory });

    await activateExtensions(registry);

    assert.deepStrictEqual(registry.active(), []);
  });

  it('does not activate an extension quarantined during discovery', async () => {
    await writeExtension('demo', { manifest: { apiVersion: '^9.0.0' } });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    assert.deepStrictEqual(recorder().activated, []);
  });
});

describe('activateExtensions quarantine', () => {
  it('quarantines an entry point that throws', async () => {
    await writeExtension('demo', {
      server: `module.exports.default = () => {
  throw new Error('activation exploded');
};`,
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    const [health] = registry.health();
    assert.strictEqual(health.status, 'failed');
    assert.match(health.error ?? '', /activation exploded/);
  });

  it('quarantines an entry point that rejects', async () => {
    await writeExtension('demo', {
      server: `module.exports.default = async () => {
  throw new Error('activation rejected');
};`,
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    assert.match(registry.get('demo')?.error ?? '', /activation rejected/);
  });

  it('activates the other extensions when one entry point throws', async () => {
    await writeExtension('broken', {
      server: `module.exports.default = () => {
  throw new Error('activation exploded');
};`,
    });
    await writeExtension('demo');
    await writeExtension('other');

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    assert.deepStrictEqual(recorder().activated, ['demo', 'other']);
    assert.deepStrictEqual(
      registry.health().map((health) => [health.id, health.status]),
      [
        ['broken', 'failed'],
        ['demo', 'active'],
        ['other', 'active'],
      ]
    );
  });

  it('discards the registrations of an extension that then throws', async () => {
    await writeExtension('demo', {
      manifest: {
        provides: {
          jobs: [{ id: 'sync', name: 'Sync', schedule: '0 * * * *' }],
        },
      },
      server: entryPoint(`
  sdk.router.get('/things', {}, () => undefined);
  sdk.jobs.register('sync', async () => undefined);
  sdk.events.on('media.available', () => undefined);
  throw new Error('too late');`),
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    assert.strictEqual(registry.get('demo')?.status, 'failed');
    assert.deepStrictEqual(registry.routes(), []);
    assert.deepStrictEqual(registry.jobs(), []);
  });

  it('does not throw when every extension fails', async () => {
    await writeExtension('broken', {
      server: `module.exports.default = () => {
  throw new Error('activation exploded');
};`,
    });

    const registry = await discoverExtensions({ directory });

    await assert.doesNotReject(() => activateExtensions(registry));
  });
});

describe('extension sdk gating', () => {
  it('always provides id, logger, router and events', async () => {
    await writeExtension('demo');

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    const sdk = sdkFor('demo');
    assert.strictEqual(sdk.id, 'demo');
    assert.ok(sdk.logger);
    assert.ok(sdk.router);
    assert.ok(sdk.events);
  });

  it('withholds every gated capability from an extension that requires nothing', async () => {
    await writeExtension('demo');

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    // Absent means the property is not there — not present-and-undefined, and
    // not a stub that throws. `in` rather than a value comparison, because only
    // `in` tells those apart.
    assert.deepStrictEqual(
      GATED_CAPABILITIES.filter((capability) => capability in sdkFor('demo')),
      []
    );
  });

  it('leaves an ungated capability off the object rather than set to undefined', async () => {
    await writeExtension('demo', { manifest: { requires: { store: true } } });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    assert.deepStrictEqual(Object.keys(sdkFor('demo')).sort(), [
      'events',
      'id',
      'logger',
      'router',
      'store',
    ]);
  });

  it('provides users only to an extension that requires users', async () => {
    await writeExtension('with-users', {
      manifest: { id: 'with-users', requires: { users: 'read' } },
    });
    await writeExtension('without-users', {
      manifest: { id: 'without-users', requires: { media: 'read' } },
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    assert.ok(sdkFor('with-users').users);
    assert.strictEqual('users' in sdkFor('without-users'), false);
  });

  it('provides media only to an extension that requires media', async () => {
    await writeExtension('demo', {
      manifest: { requires: { media: 'read' } },
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    const sdk = sdkFor('demo');
    assert.ok(sdk.media);
    assert.strictEqual('users' in sdk, false);
  });

  /**
   * `media: 'write'` was accepted by the manifest schema from the start but
   * granted nothing extra — the gate tested only whether `requires.media` was
   * *present*, so `'read'` and `'write'` produced the same object. That made the
   * access level documentation rather than enforcement.
   */
  it('withholds the destructive media members from a read-only extension', async () => {
    await writeExtension('demo', {
      manifest: { requires: { media: 'read' } },
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    const media = sdkFor('demo').media;

    assert.ok(media?.get);
    assert.ok(media?.findByTmdbId);
    // `in`, not a truthiness check: absent and present-but-undefined are
    // different promises to make to an extension author.
    assert.strictEqual('remove' in (media ?? {}), false);
  });

  it('grants media.remove to an extension that requires media write access', async () => {
    await writeExtension('demo', {
      manifest: { requires: { media: 'write' } },
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    const media = sdkFor('demo').media;

    assert.ok(media?.remove);
    // The read half is still there — write is additive, not a separate mode.
    assert.ok(media?.get);
  });

  it('provides requests only to an extension that requires requests', async () => {
    await writeExtension('demo', {
      manifest: { requires: { requests: 'read' } },
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    assert.ok(sdkFor('demo').requests);
  });

  it('provides the store only to an extension that requires it', async () => {
    await writeExtension('demo', { manifest: { requires: { store: true } } });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    const sdk = sdkFor('demo');
    assert.ok(sdk.store);
    assert.ok(sdk.store?.kv);
  });

  it('provides jobs only to an extension that requires them', async () => {
    await writeExtension('demo', { manifest: { requires: { jobs: true } } });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    assert.ok(sdkFor('demo').jobs);
  });

  it('provides notify only to an extension that declares a notification', async () => {
    await writeExtension('notifier', {
      manifest: {
        id: 'notifier',
        provides: { notifications: [{ key: 'milestone', name: 'Milestone' }] },
      },
    });
    await writeExtension('quiet', { manifest: { id: 'quiet' } });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    assert.ok(sdkFor('notifier').notify);
    assert.strictEqual('notify' in sdkFor('quiet'), false);
  });

  it('labels the extension logger', async () => {
    await writeExtension('demo');

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    // `logger.child` labels by merging meta into each written record rather than
    // by setting `defaultMeta`, so the label is only observable on a write.
    const write = mock.method(logger, 'write');
    try {
      sdkFor('demo').logger.info('hello');
    } finally {
      write.mock.restore();
    }

    assert.strictEqual(
      write.mock.calls[0].arguments[0].label,
      'Extension:demo'
    );
  });
});

describe('extension sdk core data access', () => {
  it('reads a user through sdk.users', async () => {
    await writeExtension('demo', {
      manifest: { requires: { users: 'read' } },
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    const admin = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    const user = await sdkFor('demo').users?.get(admin.id);

    assert.strictEqual(user?.email, 'admin@seerr.dev');
  });

  it('returns null for a user that does not exist', async () => {
    await writeExtension('demo', {
      manifest: { requires: { users: 'read' } },
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    assert.strictEqual(await sdkFor('demo').users?.get(9999), null);
  });

  it('grants an admin every extension permission', async () => {
    await writeExtension('demo', {
      manifest: { requires: { users: 'read' } },
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    const admin = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    assert.strictEqual(
      await sdkFor('demo').users?.hasPermission(admin.id, 'anything'),
      true
    );
  });

  it('resolves a core permission for a non-admin', async () => {
    await writeExtension('demo', {
      manifest: { requires: { users: 'read' } },
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    const friend = await getRepository(User).findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    const users = sdkFor('demo').users;

    assert.strictEqual(await users?.hasPermission(friend.id, 'REQUEST'), true);
    assert.strictEqual(
      await users?.hasPermission(friend.id, 'MANAGE_USERS'),
      false
    );
  });

  it('delegates permission resolution to the injected resolver', async () => {
    await writeExtension('demo', {
      manifest: { requires: { users: 'read' } },
    });
    const asked: [string, number, string | number][] = [];

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry, {
      hasPermission: async (extensionId, userId, permission) => {
        asked.push([extensionId, userId, permission]);
        return true;
      },
    });

    assert.strictEqual(
      await sdkFor('demo').users?.hasPermission(7, 'view_own'),
      true
    );
    assert.deepStrictEqual(asked, [['demo', 7, 'view_own']]);
  });

  it('redacts the api key from sdk.settings', async () => {
    await writeExtension('demo', {
      manifest: { requires: { settings: 'read' } },
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry, {
      getMainSettings: () =>
        ({
          apiKey: 'super-secret',
          applicationTitle: 'Seerr',
        }) as never,
    });

    const main = sdkFor('demo').settings?.main;
    assert.strictEqual(main?.apiKey, '');
    assert.strictEqual(main?.applicationTitle, 'Seerr');
  });

  it("hands an extension core's Tautulli connection, with the key redacted", async () => {
    // Core already knows where Tautulli is. An extension reading watch history
    // from it should not make the operator configure the same server twice —
    // and duplicated connection details drift the moment one is changed.
    await writeExtension('demo', {
      manifest: { requires: { settings: 'read' } },
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry, {
      getTautulliSettings: () => ({
        hostname: 'tautulli.local',
        port: 8181,
        apiKey: 'tautulli-secret',
      }),
    });

    const tautulli = sdkFor('demo').settings?.tautulli;
    assert.strictEqual(tautulli?.hostname, 'tautulli.local');
    assert.strictEqual(tautulli?.port, 8181);
    // Redacted for the same reason `main.apiKey` is: an extension that needs to
    // *call* Tautulli asks core to, rather than holding the operator's key.
    assert.strictEqual('apiKey' in tautulli, false);
  });

  it('withholds the Tautulli connection from an extension that did not require settings', async () => {
    await writeExtension('demo', {
      manifest: {
        provides: { settings: [{ key: 'a', type: 'string', name: 'A' }] },
      },
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    // `provides.settings` attaches `own` alone. Core's Tautulli config is core's
    // settings, so it travels with `requires.settings` like `main` does.
    assert.strictEqual('tautulli' in (sdkFor('demo').settings ?? {}), false);
  });

  it('reflects a settings change made after activation', async () => {
    await writeExtension('demo', {
      manifest: { requires: { settings: 'read' } },
    });
    let title = 'Seerr';

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry, {
      getMainSettings: () => ({ apiKey: '', applicationTitle: title }) as never,
    });

    title = 'Renamed';
    assert.strictEqual(
      sdkFor('demo').settings?.main?.applicationTitle,
      'Renamed'
    );
  });

  it('hands an extension the values of the settings it declares', async () => {
    await writeExtension('demo', {
      manifest: {
        provides: {
          settings: [
            { key: 'endpoint', type: 'string', name: 'Endpoint' },
            {
              key: 'batch_size',
              type: 'number',
              name: 'Batch Size',
              default: 25,
            },
          ],
        },
      },
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry, {
      getSettingValues: (id) =>
        id === 'demo'
          ? { endpoint: 'https://plex.tv', batch_size: 25 }
          : ({} as Record<string, never>),
    });

    assert.deepStrictEqual(sdkFor('demo').settings?.own, {
      endpoint: 'https://plex.tv',
      batch_size: 25,
    });
  });

  it('attaches settings for provides.settings alone, without requires.settings', async () => {
    // Declaring a setting is a reason to read one's own values; it is not a
    // request for core's, which `requires.settings` is.
    await writeExtension('demo', {
      manifest: {
        provides: {
          settings: [{ key: 'endpoint', type: 'string', name: 'Endpoint' }],
        },
      },
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    const settings = sdkFor('demo').settings;
    assert.ok(settings);
    assert.strictEqual('main' in settings, false);
  });

  it('reflects a declared setting changed after activation', async () => {
    await writeExtension('demo', {
      manifest: {
        provides: {
          settings: [{ key: 'endpoint', type: 'string', name: 'Endpoint' }],
        },
      },
    });
    let endpoint = 'https://plex.tv';

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry, {
      getSettingValues: () => ({ endpoint }),
    });

    // The admin form writes into a running Seerr, so a value read at activation
    // and cached would be stale from the moment an operator saved the form.
    endpoint = 'https://jellyfin.local';
    assert.strictEqual(
      sdkFor('demo').settings?.own.endpoint,
      'https://jellyfin.local'
    );
  });

  it('does not freeze the resolver’s own object when reading them', async () => {
    await writeExtension('demo', {
      manifest: {
        provides: {
          settings: [{ key: 'endpoint', type: 'string', name: 'Endpoint' }],
        },
      },
    });
    // Handed out by reference, which a resolver is entitled to do — the default
    // one builds a fresh object per call, but that is its choice and not a
    // contract the reader may rely on.
    const values: Record<string, string> = { endpoint: 'https://plex.tv' };

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry, { getSettingValues: () => values });

    // `own` is frozen, so an extension cannot write to what it reads...
    const own = sdkFor('demo').settings?.own;
    assert.ok(own);
    assert.strictEqual(Object.isFrozen(own), true);

    // ...but `Object.freeze` mutates its argument, so freezing the resolver's
    // return value directly would seal *its* object and make every later write
    // silently fail — or throw, under a strict-mode caller.
    assert.strictEqual(Object.isFrozen(values), false);
    values.endpoint = 'https://jellyfin.local';
    assert.strictEqual(
      sdkFor('demo').settings?.own.endpoint,
      'https://jellyfin.local'
    );
  });

  it('reports an empty record for an extension that declares no settings', async () => {
    await writeExtension('demo', {
      manifest: { requires: { settings: 'read' } },
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    assert.deepStrictEqual(sdkFor('demo').settings?.own, {});
  });

  it('withholds settings entirely when neither declaration is present', async () => {
    await writeExtension('demo');

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    assert.strictEqual('settings' in sdkFor('demo'), false);
  });
});

describe('extension sdk store', () => {
  async function activateStoreExtension(id = 'demo') {
    await writeExtension(id, { manifest: { id, requires: { store: true } } });
    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);
    return sdkFor(id).store;
  }

  it('exposes the main DataSource', async () => {
    const store = await activateStoreExtension();

    assert.strictEqual(store?.dataSource.isInitialized, true);
  });

  it('round-trips a key/value pair', async () => {
    const store = await activateStoreExtension();

    await store?.kv.set('cursor', { at: 42 });

    assert.deepStrictEqual(await store?.kv.get('cursor'), { at: 42 });
  });

  it('returns null for a key that was never set', async () => {
    const store = await activateStoreExtension();

    assert.strictEqual(await store?.kv.get('missing'), null);
  });

  it('overwrites an existing key', async () => {
    const store = await activateStoreExtension();

    await store?.kv.set('cursor', 1);
    await store?.kv.set('cursor', 2);

    assert.strictEqual(await store?.kv.get('cursor'), 2);
    assert.strictEqual(
      await getRepository(ExtensionKv).countBy({ extensionId: 'demo' }),
      1
    );
  });

  it('deletes a key', async () => {
    const store = await activateStoreExtension();

    await store?.kv.set('cursor', 1);
    await store?.kv.delete('cursor');

    assert.strictEqual(await store?.kv.get('cursor'), null);
  });

  it('lists only its own keys', async () => {
    await writeExtension('one', {
      manifest: { id: 'one', requires: { store: true } },
    });
    await writeExtension('two', {
      manifest: { id: 'two', requires: { store: true } },
    });
    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    await sdkFor('one').store?.kv.set('mine', 1);
    await sdkFor('two').store?.kv.set('theirs', 2);

    assert.deepStrictEqual(await sdkFor('one').store?.kv.list(), ['mine']);
    assert.strictEqual(await sdkFor('two').store?.kv.get('mine'), null);
  });

  it('filters listed keys by prefix', async () => {
    const store = await activateStoreExtension();

    await store?.kv.set('sync:movie', 1);
    await store?.kv.set('sync:tv', 2);
    await store?.kv.set('other', 3);

    assert.deepStrictEqual(await store?.kv.list('sync:'), [
      'sync:movie',
      'sync:tv',
    ]);
  });

  it('namespaces kv rows by extension id', async () => {
    const store = await activateStoreExtension();

    await store?.kv.set('cursor', 1);

    const row = await getRepository(ExtensionKv).findOneOrFail({
      where: { extensionId: 'demo', key: 'cursor' },
    });
    assert.strictEqual(row.value, 1);
  });
});

describe('extension registry registrations', () => {
  it('records a declared route', async () => {
    await writeExtension('demo', {
      server: entryPoint(
        `sdk.router.get('/things', { permission: 'view_own' }, () => undefined);`
      ),
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    assert.deepStrictEqual(
      registry
        .routes()
        .map((route) => [
          route.extensionId,
          route.method,
          route.path,
          route.options.permission,
        ]),
      [['demo', 'get', '/things', 'view_own']]
    );
  });

  it('records every http method', async () => {
    await writeExtension('demo', {
      server: entryPoint(`
  sdk.router.get('/a', {}, () => undefined);
  sdk.router.post('/b', {}, () => undefined);
  sdk.router.put('/c', {}, () => undefined);
  sdk.router.delete('/d', {}, () => undefined);`),
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    assert.deepStrictEqual(
      registry.routes().map((route) => route.method),
      ['get', 'post', 'put', 'delete']
    );
  });

  it('records routes per extension', async () => {
    await writeExtension('one', {
      manifest: { id: 'one' },
      server: entryPoint(`sdk.router.get('/mine', {}, () => undefined);`),
    });
    await writeExtension('two', {
      manifest: { id: 'two' },
      server: entryPoint(`sdk.router.get('/theirs', {}, () => undefined);`),
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    assert.deepStrictEqual(
      registry.routesFor('one').map((route) => route.path),
      ['/mine']
    );
  });

  it('records a job with the schedule from the manifest', async () => {
    await writeExtension('demo', {
      manifest: {
        requires: { jobs: true },
        provides: {
          jobs: [
            { id: 'sync', name: 'Sync Watch History', schedule: '0 */6 * * *' },
          ],
        },
      },
      server: entryPoint(`sdk.jobs.register('sync', async () => undefined);`),
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    assert.deepStrictEqual(
      registry
        .jobs()
        .map((job) => [job.extensionId, job.id, job.name, job.schedule]),
      [['demo', 'sync', 'Sync Watch History', '0 */6 * * *']]
    );
  });

  it('quarantines an extension registering an undeclared job', async () => {
    await writeExtension('demo', {
      manifest: { requires: { jobs: true } },
      server: entryPoint(`sdk.jobs.register('sync', async () => undefined);`),
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    assert.strictEqual(registry.get('demo')?.status, 'failed');
    assert.match(registry.get('demo')?.error ?? '', /sync/);
    assert.deepStrictEqual(registry.jobs(), []);
  });

  it('records the panels the manifest declares', async () => {
    const extensionDirectory = await writeExtension('demo', {
      manifest: {
        provides: {
          panels: [
            {
              slug: 'history',
              title: 'Watch History',
              entry: 'dist/panel.js',
              sidebar: { icon: 'ClockIcon', order: 50 },
            },
          ],
        },
      },
      files: { 'dist/panel.js': 'export default () => null;' },
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    assert.deepStrictEqual(
      registry
        .panels()
        .map((panel) => [panel.extensionId, panel.slug, panel.entryPath]),
      [['demo', 'history', path.join(extensionDirectory, 'dist/panel.js')]]
    );
  });

  it('records no panels for an extension that failed to activate', async () => {
    await writeExtension('demo', {
      manifest: {
        provides: {
          panels: [
            { slug: 'history', title: 'Watch History', entry: 'dist/panel.js' },
          ],
        },
      },
      server: `module.exports.default = () => {
  throw new Error('activation exploded');
};`,
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    assert.deepStrictEqual(registry.panels(), []);
  });

  it('dispatches an event to a subscribed extension', async () => {
    await writeExtension('demo', {
      server: entryPoint(`
  sdk.events.on('media.available', (payload) => {
    record.activated.push('media.available:' + payload.is4k);
  });`),
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);
    await registry.emit('media.available', {
      media: {} as never,
      is4k: false,
    });

    assert.deepStrictEqual(recorder().activated, [
      'demo',
      'media.available:false',
    ]);
  });

  it('does not let a throwing listener escape emit', async () => {
    await writeExtension('demo', {
      server: entryPoint(`
  sdk.events.on('media.available', () => {
    throw new Error('listener exploded');
  });`),
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    await assert.doesNotReject(() =>
      registry.emit('media.available', { media: {} as never, is4k: true })
    );
  });
});

describe('extension sdk notify', () => {
  it('routes a declared notification to the injected sender', async () => {
    await writeExtension('demo', {
      manifest: {
        provides: { notifications: [{ key: 'milestone', name: 'Milestone' }] },
      },
    });
    const sent: [string, string, string][] = [];

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry, {
      sendNotification: async (extensionId, key, payload) => {
        sent.push([extensionId, key, payload.subject]);
      },
    });

    await sdkFor('demo').notify?.send('milestone', { subject: 'Hello' });

    assert.deepStrictEqual(sent, [['demo', 'milestone', 'Hello']]);
  });

  it('rejects a notification key the manifest does not declare', async () => {
    await writeExtension('demo', {
      manifest: {
        provides: { notifications: [{ key: 'milestone', name: 'Milestone' }] },
      },
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry);

    await assert.rejects(
      () =>
        sdkFor('demo').notify?.send('unknown', { subject: 'Hello' }) ??
        Promise.resolve(),
      /unknown/
    );
  });
});

describe('activateExtensions migrations', () => {
  let migrationOptions: DataSourceOptions;
  let migrationDirectory: string;

  beforeEach(async () => {
    migrationDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'seerr-ext-loader-db-')
    );
    migrationOptions = {
      type: 'sqlite',
      database: path.join(migrationDirectory, 'db.sqlite3'),
      entities: [],
      migrations: [],
    };
    const core = await new DataSource(migrationOptions).initialize();
    await core.query(
      `CREATE TABLE "user" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL)`
    );
    await core.destroy();
  });

  afterEach(async () => {
    await fs.rm(migrationDirectory, { recursive: true, force: true });
  });

  function migrationSource(sql: string, name: string): string {
    return `class ExtensionMigration {
  constructor() {
    this.name = ${JSON.stringify(name)};
  }
  async up(queryRunner) {
    await queryRunner.query(${JSON.stringify(sql)});
  }
  async down() {}
}
module.exports.migrations = [ExtensionMigration];
`;
  }

  it('runs an extension migration before activating it', async () => {
    await writeExtension('demo', {
      server: `${migrationSource(
        `CREATE TABLE "ext_demo_event" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL)`,
        'CreatesDemoEvent1000000000001'
      )}${entryPoint()}`,
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry, {
      migrationBaseOptions: migrationOptions,
    });

    assert.strictEqual(registry.get('demo')?.status, 'active');

    const core = await new DataSource(migrationOptions).initialize();
    try {
      assert.ok(await core.createQueryRunner().getTable('ext_demo_event'));
    } finally {
      await core.destroy();
    }
  });

  it('quarantines an extension whose migration fails', async () => {
    await writeExtension('demo', {
      server: `${migrationSource(
        `DROP TABLE "user"`,
        'DropsUser1000000000002'
      )}${entryPoint()}`,
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry, {
      migrationBaseOptions: migrationOptions,
    });

    assert.strictEqual(registry.get('demo')?.status, 'failed');
    assert.match(registry.get('demo')?.error ?? '', /user/);
  });

  it('does not activate an extension whose migration failed', async () => {
    await writeExtension('demo', {
      server: `${migrationSource(
        `DROP TABLE "user"`,
        'DropsUser1000000000003'
      )}${entryPoint()}`,
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry, {
      migrationBaseOptions: migrationOptions,
    });

    assert.deepStrictEqual(recorder().activated, []);
  });

  it('activates the other extensions when one migration fails', async () => {
    await writeExtension('broken', {
      server: `${migrationSource(
        `DROP TABLE "user"`,
        'DropsUser1000000000004'
      )}${entryPoint()}`,
    });
    await writeExtension('demo');

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry, {
      migrationBaseOptions: migrationOptions,
    });

    assert.deepStrictEqual(recorder().activated, ['demo']);
    assert.deepStrictEqual(
      registry.health().map((health) => [health.id, health.status]),
      [
        ['broken', 'failed'],
        ['demo', 'active'],
      ]
    );
  });

  // Dev and test run the main DataSource with `synchronize: true`, which creates
  // the extension's tables from its entities before activation gets a chance to
  // migrate them. Running the migrations anyway would fail on the tables
  // synchronize just made and quarantine the extension on every dev boot.
  it('skips migrations when the schema is synchronized instead', async () => {
    await writeExtension('demo', {
      server: `${migrationSource(
        `CREATE TABLE "ext_demo_event" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL)`,
        'CreatesDemoEvent1000000000005'
      )}${entryPoint()}`,
    });

    const registry = await discoverExtensions({ directory });
    await activateExtensions(registry, {
      migrationBaseOptions: migrationOptions,
      runMigrations: false,
    });

    assert.strictEqual(registry.get('demo')?.status, 'active');

    const core = await new DataSource(migrationOptions).initialize();
    try {
      assert.strictEqual(
        await core.createQueryRunner().hasTable('ext_demo_migration'),
        false
      );
    } finally {
      await core.destroy();
    }
  });
});
