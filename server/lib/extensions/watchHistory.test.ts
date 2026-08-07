/**
 * The Watch History reference extension, loaded the way a real install is.
 *
 * This is slice 9, and it is deliberately an *integration* test rather than unit
 * tests living next to the extension: `examples/watch-history` is not part of any
 * tsconfig this suite compiles, and it must not be — an extension is built
 * separately, installed into `config/extensions/<id>/`, and `require()`d from
 * disk. So this test does exactly that. It compiles the example with its own
 * `tsc`, points `discoverExtensions` at a directory containing the built output,
 * and drives the result through the real loader.
 *
 * What that buys over the fixture extensions in `loader.test.ts`: those fixtures
 * are hand-written CommonJS strings shaped to exercise one loader branch each.
 * This one is written the way the docs tell an author to write one — TypeScript,
 * `defineExtension`, an imported manifest, entities and migrations as module
 * exports — so it fails if the *authoring* path is broken even when every loader
 * branch still works.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { promisify } from 'node:util';

import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import {
  clearExtensionEventSource,
  emitExtensionEvent,
  setExtensionEventSource,
} from '@server/lib/extensions/events';
import {
  activateExtensions,
  discoverExtensions,
  injectExtensionEntities,
} from '@server/lib/extensions/loader';
import { parseManifest } from '@server/lib/extensions/manifest';
import { runExtensionMigrations } from '@server/lib/extensions/migrations';
import type {
  ExtensionNotificationPayload,
  ExtensionRouteRequest,
} from '@server/lib/extensions/types';
import { setupTestDb } from '@server/test/db';
import buildExtensionPackages from '@server/test/extensionPackagesBuild';
import { seedTestDb } from '@server/utils/seedTestDb';
import type { Response } from 'express';

setupTestDb();

const execFileAsync = promisify(execFile);

/** Where the example lives, relative to this file. */
const EXAMPLE_DIRECTORY = path.join(
  __dirname,
  '../../../examples/watch-history'
);

/**
 * Compiling takes a few seconds, and the whole file shares one build.
 */
const BUILD_TIMEOUT = 180_000;

let directory: string;
let installed: string;

before(async () => {
  // The examples resolve the SDK and UI packages to their gitignored
  // `dist/index.d.ts`, so both must be built before this `tsc` runs.
  await buildExtensionPackages();

  // Built here rather than assumed present, so the test cannot pass against a
  // stale `dist/` and does not need a `pretest` hook nobody would remember.
  await execFileAsync(
    'npx',
    ['--no-install', 'tsc', '--project', 'tsconfig.json'],
    { cwd: EXAMPLE_DIRECTORY, timeout: BUILD_TIMEOUT }
  );
  await execFileAsync(
    'npx',
    ['--no-install', 'tsc', '--project', 'tsconfig.panel.json'],
    { cwd: EXAMPLE_DIRECTORY, timeout: BUILD_TIMEOUT }
  );

  // The extension is *copied* into an extensions directory, because that is what
  // an install does — `discoverExtensions` reads a directory of extension
  // directories, and the repo's `examples/` is not one.
  //
  // Created inside the repository rather than in `os.tmpdir()`, and this matters:
  // the built entry point is plain CommonJS `require`ing `zod` by name, so Node
  // resolves it by walking parent directories for a `node_modules`. From
  // `/var/folders/…` there is none, and the extension fails to load for a reason
  // that has nothing to do with the extension.
  directory = await fs.mkdtemp(path.join(__dirname, '../../../.ext-test-'));
  installed = path.join(directory, 'watch-history');
  await fs.cp(EXAMPLE_DIRECTORY, installed, {
    recursive: true,
    filter: (source) => !source.includes('node_modules'),
  });

  // `@constructorfleet/extension-sdk` is deliberately *not* a dependency of the root app, so
  // walking up will not find it. A real install gets it in its own
  // `node_modules`; this is that, by symlink.
  const sdkLink = path.join(installed, 'node_modules/@seerr');
  await fs.mkdir(sdkLink, { recursive: true });
  await fs.symlink(
    path.join(__dirname, '../../../packages/extension-sdk'),
    path.join(sdkLink, 'extension-sdk'),
    'dir'
  );
});

after(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe('the watch-history manifest', () => {
  it('is valid against the host schema', async () => {
    const raw = JSON.parse(
      await fs.readFile(
        path.join(EXAMPLE_DIRECTORY, 'seerr-extension.json'),
        'utf8'
      )
    );

    const manifest = parseManifest(raw);

    assert.equal(manifest.id, 'watch-history');
    // Every capability the slice is meant to exercise.
    assert.ok(manifest.requires?.store);
    assert.ok(manifest.requires?.jobs);
    assert.equal(manifest.requires?.users, 'read');
    assert.equal(manifest.provides?.permissions?.length, 2);
    assert.equal(manifest.provides?.notifications?.length, 1);
    assert.equal(manifest.provides?.panels?.length, 1);
    assert.equal(manifest.provides?.jobs?.length, 1);
  });

  it('ships the built panel bundle its manifest names', async () => {
    const raw = JSON.parse(
      await fs.readFile(
        path.join(EXAMPLE_DIRECTORY, 'seerr-extension.json'),
        'utf8'
      )
    );
    const manifest = parseManifest(raw);
    const entry = manifest.provides?.panels?.[0].entry as string;

    // A panel whose bundle is missing fails at `import()` in the browser with
    // nothing on the server to explain it, so the build producing the exact file
    // the manifest names is worth pinning.
    await fs.access(path.join(EXAMPLE_DIRECTORY, entry));
  });

  it('emits a panel bundle that only imports host-shared specifiers', async () => {
    const raw = JSON.parse(
      await fs.readFile(
        path.join(EXAMPLE_DIRECTORY, 'seerr-extension.json'),
        'utf8'
      )
    );
    const manifest = parseManifest(raw);
    const entry = manifest.provides?.panels?.[0].entry as string;
    const bundle = await fs.readFile(
      path.join(EXAMPLE_DIRECTORY, entry),
      'utf8'
    );

    const specifiers = [...bundle.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1]
    );

    assert.ok(specifiers.length, 'the bundle imports nothing at all');

    // An unmapped bare specifier does not fail loudly — it resolves to a second
    // copy of the package, which renders and then breaks on the first hook. See
    // `sharedModuleSpecifiers.ts`.
    const { SHARED_MODULE_SPECIFIERS } =
      await import('@server/lib/extensions/sharedModuleSpecifiers');

    for (const specifier of specifiers) {
      assert.ok(
        (SHARED_MODULE_SPECIFIERS as readonly string[]).includes(specifier),
        `panel bundle imports "${specifier}", which the host import map does not provide`
      );
    }
  });

  it('agrees with the TypeScript manifest the entry point narrows from', async () => {
    // Two copies exist on purpose, and this is what keeps them honest.
    //
    // `defineExtension` recovers non-optional SDK capabilities from the
    // manifest's *literal* type, and `resolveJsonModule` widens as it infers — a
    // JSON `true` becomes `boolean`, so `DeclaredCapability` matches nothing and
    // an imported JSON manifest narrows *nothing*. `src/manifest.ts` is the
    // `as const` literal that does narrow; this file is what the host reads. A
    // divergence is invisible until the extension asks for a capability the real
    // manifest never declared, at which point `sdk.store` is undefined in
    // production while the types said otherwise.
    const raw = JSON.parse(
      await fs.readFile(
        path.join(EXAMPLE_DIRECTORY, 'seerr-extension.json'),
        'utf8'
      )
    );

    // Read from `dist`, not `src`: this asserts what actually shipped. Loaded
    // with `require` because the emit is CommonJS.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { manifest } = require(
      path.join(EXAMPLE_DIRECTORY, 'dist/manifest.js')
    ) as { manifest: unknown };

    assert.deepEqual(raw, manifest);
  });
});

describe('the watch-history migration', () => {
  it('runs, and creates only tables inside its own namespace', async () => {
    const registry = await discoverExtensions({ directory });
    const entry = registry.all()[0];

    assert.equal(
      entry.migrations.length,
      1,
      'the migration is not reaching the loader as a module export'
    );

    // Run against a scratch DataSource rather than the suite's, so this is the
    // migration path (what a production sqlite/Postgres install takes) and not
    // the `synchronize: true` path the behaviour suite uses. The host's prefix
    // guard wraps the QueryRunner, so a migration touching a table outside
    // `ext_watch-history_` is refused here and reported as an error.
    const results = await runExtensionMigrations(
      [{ id: entry.id, migrations: entry.migrations }],
      {
        baseOptions: {
          type: 'sqlite',
          database: ':memory:',
        },
      }
    );

    assert.equal(results.length, 1);
    assert.equal(results[0].error, undefined, String(results[0].error));
    assert.deepEqual(results[0].migrations, ['CreateWatchEvent1754280000000']);
  });
});

describe('loading watch-history', () => {
  it('discovers, activates, and registers everything it declares', async () => {
    const registry = await discoverExtensions({ directory });

    assert.deepEqual(
      registry.all().map((entry) => [entry.id, entry.status]),
      [['watch-history', 'pending']]
    );
    assert.equal(
      registry.all()[0].entities.length,
      1,
      'the entity is not reaching the loader as a module export'
    );

    // No entity injection here: activation only runs the entry point, which
    // registers routes and jobs without touching the database. The behaviour
    // suite below is what needs a real table.
    await activateExtensions(registry, { runMigrations: false });

    const entry = registry.all()[0];
    assert.equal(entry.status, 'active', entry.error);
    assert.deepEqual(
      registry.panelsFor('watch-history').map((panel) => panel.slug),
      ['history']
    );
    assert.deepEqual(
      registry.jobs().map((job) => [job.extensionId, job.id]),
      [['watch-history', 'sync']]
    );
    assert.ok(
      registry.routesFor('watch-history').length >= 2,
      'expected the history routes to be registered'
    );
  });
});

/**
 * The extension actually doing its job.
 *
 * Everything below runs against one activated registry, sharing the same
 * `beforeEach` database reset as the rest of the suite. Registrations are pulled
 * off the registry and invoked directly — a route handler with a fake `req`/`res`,
 * the job as the function it registered — because what is under test is the
 * extension's logic, not the router and scheduler that slices 5 and 3 already
 * cover.
 */
describe('watch-history behaviour', () => {
  let registry: Awaited<ReturnType<typeof discoverExtensions>>;
  let sent: { key: string; payload: ExtensionNotificationPayload }[];
  /** What the injected `hasPermission` answers true for. */
  const granted = new Set(['view_own', 'view_all']);

  beforeEach(() => {
    granted.add('view_own');
    granted.add('view_all');
  });

  before(async () => {
    registry = await discoverExtensions({ directory });

    // Injecting entities appends to the DataSource's *options*; TypeORM builds
    // its metadata during `initialize()` and will not rebuild it afterwards. In
    // production that is fine — boot injects before initializing — but this
    // suite's DataSource was already initialized by `setupTestDb`, so it has to
    // be cycled for `getRepository(WatchEvent)` to resolve at all. Re-seeding is
    // part of that: the test database is `:memory:`, so destroying it takes the
    // schema with it.
    injectExtensionEntities(dataSource, registry);
    await dataSource.destroy();
    await seedTestDb();

    sent = [];
    await activateExtensions(registry, {
      runMigrations: false,
      // Mutable so a test can revoke `view_all` for the case that matters. The
      // permission *resolution* rules are slice 4's tests; what is under test
      // here is whether this extension asks, and what it does with the answer.
      hasPermission: async (_extensionId, _forUser, permission) =>
        granted.has(String(permission)),
      sendNotification: async (_id, key, payload) => {
        sent.push({ key, payload });
      },
    });

    assert.equal(registry.all()[0].status, 'active', registry.all()[0].error);
  });

  /**
   * A route handler, by method and path, with a minimal `req`/`res`.
   *
   * `user` is just an id: `req.user` is typed as the full `User` entity through
   * core's global Express augmentation, and constructing one per call would say
   * nothing — these handlers only ever read `req.user.id`.
   */
  const call = async (
    method: 'get' | 'post',
    routePath: string,
    req: {
      user?: { id: number };
      query?: Record<string, string>;
      body?: unknown;
    }
  ): Promise<{ status: number; body: unknown }> => {
    const route = registry
      .routesFor('watch-history')
      .find((entry) => entry.method === method && entry.path === routePath);

    assert.ok(route, `no ${method} ${routePath} route is registered`);

    const captured: { status: number; body: unknown } = {
      status: 0,
      body: undefined,
    };
    const res = {
      status(code: number) {
        captured.status = code;
        return this;
      },
      json(body: unknown) {
        captured.body = body;
        return this;
      },
    } as unknown as Response;

    await route.handler(
      { query: {}, body: {}, ...req } as unknown as ExtensionRouteRequest,
      res
    );

    return captured;
  };

  const userId = async (email: string): Promise<number> =>
    (await getRepository(User).findOneOrFail({ where: { email } })).id;

  it('records a manual watch and reads it back', async () => {
    const id = await userId('friend@seerr.dev');

    const created = await call('post', '/history', {
      user: { id },
      body: { mediaId: 1, mediaType: 'movie' },
    });

    assert.equal(created.status, 201);

    const read = await call('get', '/history', { user: { id } });

    assert.equal(read.status, 200);
    const { results } = read.body as { results: { source: string }[] };
    assert.equal(results.length, 1);
    assert.equal(results[0].source, 'manual');
  });

  it('gates another user’s history on view_all', async () => {
    const friend = await userId('friend@seerr.dev');
    const admin = await userId('admin@seerr.dev');

    const allowed = await call('get', '/history', {
      user: { id: admin },
      query: { userId: String(friend) },
    });

    assert.equal(allowed.status, 200);

    granted.delete('view_all');

    const refused = await call('get', '/history', {
      user: { id: admin },
      query: { userId: String(friend) },
    });

    assert.equal(refused.status, 403);

    // Their *own* history is still readable — the route's declared `view_own` is
    // what covers that, and the extra check must not spill onto it.
    const own = await call('get', '/history', { user: { id: admin } });
    assert.equal(own.status, 200);
  });

  it('rejects an invalid query with a 400', async () => {
    const id = await userId('friend@seerr.dev');

    const response = await call('get', '/history', {
      user: { id },
      query: { take: 'lots' },
    });

    assert.equal(response.status, 400);
  });

  it('records a watch from request.available, once', async () => {
    const id = await userId('friend@seerr.dev');
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 550,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const user = await getRepository(User).findOneOrFail({ where: { id } });
    const request = { id: 1, media, requestedBy: user };

    setExtensionEventSource(registry);

    try {
      // Emitted twice deliberately: core emits `request.available` separately for
      // the 4K and non-4K transitions, and a history listing the same film twice
      // because of that is wrong in a way the user cannot explain.
      await emitExtensionEvent('request.available', {
        request: request as never,
      });
      await emitExtensionEvent('request.available', {
        request: request as never,
      });
    } finally {
      clearExtensionEventSource();
    }

    const read = await call('get', '/history', { user: { id } });
    const { results } = read.body as { results: { source: string }[] };

    assert.equal(results.length, 1);
    assert.equal(results[0].source, 'event');
  });

  it('notifies on the first watch, and not the second', async () => {
    const id = await userId('friend@seerr.dev');
    sent.length = 0;

    await call('post', '/history', {
      user: { id },
      body: { mediaId: 1, mediaType: 'movie' },
    });

    // 1 is a milestone; 2 is not.
    assert.deepEqual(
      sent.map((notification) => notification.key),
      ['milestone']
    );
    assert.match(String(sent[0].payload.subject), /^1 watched$/);
    assert.equal(sent[0].payload.notifyUser?.id, id);

    await call('post', '/history', {
      user: { id },
      body: { mediaId: 2, mediaType: 'movie' },
    });

    assert.equal(sent.length, 1);
  });

  it('prunes rows belonging to deleted users, and records the run', async () => {
    const friend = await userId('friend@seerr.dev');

    await call('post', '/history', {
      user: { id: friend },
      body: { mediaId: 1, mediaType: 'movie' },
    });
    // A row for a user id that does not exist, which is the state a deleted user
    // leaves behind — there is no foreign key, deliberately (see `WatchEvent`).
    await call('post', '/history', {
      user: { id: 9999 },
      body: { mediaId: 2, mediaType: 'movie' },
    });

    const job = registry.jobs().find((entry) => entry.id === 'sync');
    assert.ok(job);
    await job.run();

    const remaining = await call('get', '/history', { user: { id: friend } });
    const { results, lastSync } = remaining.body as {
      results: unknown[];
      lastSync: number | null;
    };

    assert.equal(results.length, 1);
    assert.ok(
      typeof lastSync === 'number',
      'the job did not write its kv cursor'
    );

    const orphaned = await call('get', '/history', { user: { id: 9999 } });
    assert.equal((orphaned.body as { results: unknown[] }).results.length, 0);
  });

  it('lists requested media with no watch row', async () => {
    const id = await userId('friend@seerr.dev');
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 680,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const user = await getRepository(User).findOneOrFail({ where: { id } });

    await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MOVIE,
        media,
        requestedBy: user,
        status: MediaRequestStatus.APPROVED,
      })
    );

    const before = await call('get', '/unwatched', { user: { id } });
    assert.deepEqual(
      (before.body as { results: { mediaId: number }[] }).results.map(
        (entry) => entry.mediaId
      ),
      [media.id]
    );

    await call('post', '/history', {
      user: { id },
      body: { mediaId: media.id, mediaType: 'movie' },
    });

    const after = await call('get', '/unwatched', { user: { id } });
    assert.equal((after.body as { results: unknown[] }).results.length, 0);
  });
});
