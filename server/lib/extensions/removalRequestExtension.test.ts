/**
 * The Media Removal Requests example extension, loaded the way a real install
 * is.
 *
 * Named `removalRequestExtension` rather than `mediaRemoval`, because
 * `server/lib/mediaRemoval.test.ts` already exists and covers core's Servarr
 * removal helper. Two files named after the same thing at different layers is a
 * reliable way to read the wrong test output for ten minutes, so the layer is in
 * the name: this is the *extension* that drives that helper through
 * `sdk.media.remove`.
 *
 * The harness is `watchHistory.test.ts`'s, deliberately unchanged in shape: the
 * example is compiled with its own `tsc`, copied into a scratch extensions
 * directory inside the repository, given `@seerr/extension-sdk` by symlink, and
 * driven through the real loader. What that buys over hand-written loader
 * fixtures is that it fails if the *authoring* path breaks — TypeScript,
 * `defineExtension`, a manifest module, entities and migrations as module
 * exports — even when every loader branch still works.
 *
 * The Radarr/Sonarr calls are the only fakes, faked the way
 * `sdkMedia.test.ts`/`mediaRemoval.test.ts` do it: `removeMovie` is an instance
 * arrow-function property, so `mock.method` cannot swap it, and a prototype
 * getter delegating to a per-test implementation can. Everything below the
 * extension — the SDK, the permission resolution, `removeMediaFromServarr`, the
 * `Media` write — is real.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { promisify } from 'node:util';

import RadarrAPI from '@server/api/servarr/radarr';
import TheMovieDb from '@server/api/themoviedb';
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
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { seedTestDb } from '@server/utils/seedTestDb';
import type { Response } from 'express';

setupTestDb();

const execFileAsync = promisify(execFile);

const EXAMPLE_DIRECTORY = path.join(
  __dirname,
  '../../../examples/media-removal'
);

const BUILD_TIMEOUT = 180_000;

/** Every removal this file's fake Radarr was asked to perform. */
let removeMovieCalls: number[] = [];
let removeMovieImpl: (tmdbId: number) => Promise<void> = async () => undefined;

Object.defineProperty(RadarrAPI.prototype, 'removeMovie', {
  get() {
    return async (tmdbId: number) => {
      removeMovieCalls.push(tmdbId);
      return removeMovieImpl(tmdbId);
    };
  },
  set() {},
  configurable: true,
});

/**
 * TMDB, faked for `sdk.media.getDetails` — which the extension's routes now call
 * to decorate every row they serve. Set `tmdbError` to stand in for an outage.
 *
 * A prototype getter rather than `mock.method` because that is the pattern the
 * other extension tests use, and the fake has to survive the extension being
 * activated between tests.
 */
let tmdbError: Error | undefined;

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  get() {
    return async ({ movieId }: { movieId: number }) => {
      if (tmdbError) {
        throw tmdbError;
      }

      return {
        id: movieId,
        title: 'Fight Club',
        release_date: '1999-10-15',
        overview: 'A ticking-time-bomb insomniac.',
        poster_path: '/poster.jpg',
        backdrop_path: '/backdrop.jpg',
      };
    };
  },
  set() {},
  configurable: true,
});

function buildRadarrSettings(
  overrides: Partial<RadarrSettings> & Pick<RadarrSettings, 'id'>
): RadarrSettings {
  return {
    name: `Radarr ${overrides.id}`,
    hostname: 'localhost',
    port: 7878,
    apiKey: 'radarr-key',
    useSsl: false,
    activeProfileId: 1,
    activeProfileName: 'HD',
    activeDirectory: '/movies',
    tags: [],
    is4k: false,
    isDefault: true,
    syncEnabled: false,
    preventSearch: false,
    tagRequests: false,
    overrideRule: [],
    minimumAvailability: 'released',
    ...overrides,
  };
}

let directory: string;
let installed: string;

before(async () => {
  // Built here rather than assumed present, so the test cannot pass against a
  // stale `dist/`.
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

  // Inside the repository, not `os.tmpdir()`: the built entry point is plain
  // CommonJS `require`ing `zod` by name, and Node resolves that by walking parent
  // directories for a `node_modules`. From `/var/folders/…` there is none.
  directory = await fs.mkdtemp(path.join(__dirname, '../../../.ext-test-mr-'));
  installed = path.join(directory, 'media-removal');
  await fs.cp(EXAMPLE_DIRECTORY, installed, {
    recursive: true,
    filter: (source) => !source.includes('node_modules'),
  });

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

const readJsonManifest = async () =>
  JSON.parse(
    await fs.readFile(
      path.join(EXAMPLE_DIRECTORY, 'seerr-extension.json'),
      'utf8'
    )
  );

describe('the media-removal manifest', () => {
  it('is valid against the host schema', async () => {
    const manifest = parseManifest(await readJsonManifest());

    assert.equal(manifest.id, 'media-removal');
    assert.ok(manifest.requires?.store);
    assert.equal(manifest.requires?.users, 'read');
    // The whole point of the extension: it needs write access to remove media,
    // and nothing else in `examples/` declares it.
    assert.equal(manifest.requires?.media, 'write');
    assert.equal(manifest.requires?.requests, 'read');
    assert.equal(manifest.requires?.settings, 'read');
    assert.deepEqual(
      manifest.provides?.permissions?.map((permission) => permission.key),
      ['request', 'manage']
    );
    assert.deepEqual(
      manifest.provides?.notifications?.map((notification) => notification.key),
      ['pending', 'approved', 'declined', 'auto_approved', 'failed']
    );
    assert.deepEqual(
      manifest.provides?.panels?.map((panel) => panel.slug),
      ['removals']
    );
  });

  it('declares no jobs, and so is handed no jobs capability', async () => {
    const manifest = parseManifest(await readJsonManifest());

    // Unlike watch-history, this extension has no housekeeping to do: a removal
    // request is acted on synchronously, so `requires.jobs` would be a capability
    // asked for and never used.
    assert.equal(manifest.requires?.jobs, undefined);
    assert.equal(manifest.provides?.jobs, undefined);
  });

  it('names notification keys of its own rather than core Notification bits', async () => {
    const raw = JSON.stringify(await readJsonManifest());

    // PR #9 numbered three new core `Notification` bits starting at 8192. 8192 is
    // now `Notification.EXTENSION`, the persisted sentinel every extension
    // notification is delivered under, so an extension that referenced a bit at
    // all would be renumbering core's enum from outside. Delivery goes through
    // `sdk.notify.send` and the host namespaces the key.
    assert.doesNotMatch(raw, /8192|16384|32768|MEDIA_REMOVAL/);
  });

  it('ships the built panel bundle its manifest names', async () => {
    const manifest = parseManifest(await readJsonManifest());
    const entry = manifest.provides?.panels?.[0].entry as string;

    await fs.access(path.join(EXAMPLE_DIRECTORY, entry));
  });

  it('agrees with the TypeScript manifest the entry point narrows from', async () => {
    // Two copies exist on purpose. `defineExtension` recovers non-optional SDK
    // capabilities from the manifest's *literal* type, and `resolveJsonModule`
    // widens as it infers, so an imported JSON manifest narrows nothing. A
    // divergence is invisible until the extension uses a capability the real
    // manifest never declared — here that would be `sdk.media.remove`, i.e. the
    // extension's entire purpose failing in production with the types satisfied.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { manifest } = require(
      path.join(EXAMPLE_DIRECTORY, 'dist/manifest.js')
    ) as { manifest: unknown };

    assert.deepEqual(await readJsonManifest(), manifest);
  });
});

describe('the media-removal migration', () => {
  it('runs, and creates only tables inside its own namespace', async () => {
    const registry = await discoverExtensions({ directory });
    const entry = registry.all()[0];

    assert.equal(
      entry.migrations.length,
      1,
      'the migration is not reaching the loader as a module export'
    );
    assert.equal(
      entry.entities.length,
      1,
      'the entity is not reaching the loader as a module export'
    );

    // A scratch DataSource, so this is the migration path a production install
    // takes rather than the `synchronize: true` path the behaviour suite uses.
    // The host's prefix guard wraps the QueryRunner, so a statement touching a
    // table outside `ext_media-removal_` is refused here.
    const results = await runExtensionMigrations(
      [{ id: entry.id, migrations: entry.migrations }],
      { baseOptions: { type: 'sqlite', database: ':memory:' } }
    );

    assert.equal(results.length, 1);
    assert.equal(results[0].error, undefined, String(results[0].error));
    assert.deepEqual(results[0].migrations, [
      'CreateRemovalRequest1785600000000',
    ]);
  });
});

describe('loading media-removal', () => {
  it('discovers, activates, and registers its route table', async () => {
    const registry = await discoverExtensions({ directory });

    await activateExtensions(registry, { runMigrations: false });

    const entry = registry.all()[0];
    assert.equal(entry.status, 'active', entry.error);
    assert.deepEqual(
      registry.panelsFor('media-removal').map((panel) => panel.slug),
      ['removals']
    );

    // The declared permission per route is the host's gate; the handlers below
    // are invoked directly, so this is where it is pinned.
    assert.deepEqual(
      registry
        .routesFor('media-removal')
        .map((route) => [route.method, route.path, route.options.permission]),
      [
        ['post', '/requests', 'request'],
        ['get', '/requests', 'request'],
        ['get', '/requests/:id', 'request'],
        ['post', '/requests/:id/:status', 'manage'],
        ['delete', '/requests/:id', 'request'],
        // `/removable` backs the panel's picker, and is gated on `request` rather
        // than `manage`: an approver reads it for their *own* requests, because
        // they now ask for a removal like everyone else.
        ['get', '/removable', 'request'],
        // No `/settings` pair. The auto-approval switch is a declared setting the
        // host serves from `/settings/extensions/media-removal` behind `ADMIN`, so
        // an extension route for it would be a second, weaker-gated door to the
        // same operator decision.
      ]
    );
  });
});

/**
 * The extension actually doing its job.
 *
 * One activated registry for the whole block, sharing the suite's `beforeEach`
 * database reset. Registrations are pulled off the registry and invoked directly
 * — the router and the permission middleware are slices 3 and 5's tests — except
 * that `call` reproduces the host's one gate that matters to these cases: a route
 * with a declared permission is not reached by a user who lacks it.
 */
describe('media-removal behaviour', () => {
  let registry: Awaited<ReturnType<typeof discoverExtensions>>;
  let sent: { key: string; payload: ExtensionNotificationPayload }[];
  /** What the injected `hasPermission` answers true for, per user id. */
  let granted: Map<number, Set<string>>;
  /**
   * Stands in for what an operator has saved on the extension's settings page.
   *
   * Injected via `getSettingValues` rather than written to `settings.json`, and
   * mutated in place so the live getter behind `sdk.settings.own` sees each
   * change — the same reason production reads it live.
   */
  let settingValues: Record<string, boolean | string | number>;

  before(async () => {
    registry = await discoverExtensions({ directory });

    // Injecting entities appends to the DataSource's *options*, and TypeORM
    // builds metadata during `initialize()` and never rebuilds it. Production
    // injects before initializing; this suite's DataSource is already up, so it
    // has to be cycled — and since the database is `:memory:`, destroying it
    // takes the schema, hence the reseed.
    injectExtensionEntities(dataSource, registry);
    await dataSource.destroy();
    await seedTestDb();

    sent = [];
    granted = new Map();
    settingValues = {};

    await activateExtensions(registry, {
      runMigrations: false,
      hasPermission: async (_extensionId, forUser, permission) =>
        granted.get(forUser)?.has(String(permission)) ?? false,
      getSettingValues: () => settingValues,
      sendNotification: async (_id, key, payload) => {
        sent.push({ key, payload });
      },
    });

    assert.equal(registry.all()[0].status, 'active', registry.all()[0].error);
  });

  beforeEach(async () => {
    sent = [];
    removeMovieCalls = [];
    removeMovieImpl = async () => undefined;
    tmdbError = undefined;

    const settings = getSettings();
    settings.radarr = [buildRadarrSettings({ id: 0 })];

    granted = new Map([
      [await userId('admin@seerr.dev'), new Set(['request', 'manage'])],
      [await userId('friend@seerr.dev'), new Set(['request'])],
    ]);

    // Reset by clearing in place rather than reassigning: the activated SDK closed
    // over this object, so a fresh one would be invisible to it. Empty means the
    // manifest's `default: false` applies, which is what a fresh install has.
    for (const key of Object.keys(settingValues)) {
      delete settingValues[key];
    }
  });
  // No explicit truncate of the extension's own table: `setupTestDb`'s
  // `beforeEach` runs first and calls `dataSource.synchronize(true)`, which drops
  // and recreates every table the DataSource knows about — including the injected
  // extension entity and `ext_kv`. That is also what resets the kv setting to its
  // absent-and-therefore-false default between tests.

  const userId = async (email: string): Promise<number> =>
    (await getRepository(User).findOneOrFail({ where: { email } })).id;

  /**
   * Invokes a route handler, after applying the route's declared permission the
   * way the host's `isExtensionAuthenticated` would.
   *
   * Emulated rather than skipped, because "a user without `request` cannot open a
   * removal request" is a property of this extension's route table and not of the
   * middleware — the handler itself never checks it, deliberately.
   */
  const call = async (
    method: 'get' | 'post' | 'delete',
    routePath: string,
    req: {
      user?: { id: number };
      params?: Record<string, string>;
      query?: Record<string, string>;
      body?: unknown;
    }
  ): Promise<{ status: number; body: unknown }> => {
    const route = registry
      .routesFor('media-removal')
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
      send() {
        return this;
      },
    } as unknown as Response;

    const required = route.options.permission;

    if (
      required &&
      !(req.user && granted.get(req.user.id)?.has(String(required)))
    ) {
      return { status: 403, body: { message: 'forbidden' } };
    }

    await route.handler(
      {
        params: {},
        query: {},
        body: {},
        ...req,
      } as unknown as ExtensionRouteRequest,
      res
    );

    return captured;
  };

  /**
   * A movie, plus an owning core request for `friend`, which is the usual case.
   *
   * The overrides are applied *after* the request is saved, not as part of the
   * `Media` construction, and that ordering is not cosmetic: core's
   * `MediaRequestSubscriber` reacts to an inserted request by moving the media to
   * `PROCESSING`, so a status set beforehand is silently overwritten and a test
   * for "already DELETED" would exercise "PROCESSING" instead.
   */
  const seedRequestedMovie = async (
    overrides?: Partial<Media>
  ): Promise<Media> => {
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 550,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MOVIE,
        media,
        requestedBy: await getRepository(User).findOneOrFail({
          where: { email: 'friend@seerr.dev' },
        }),
        status: MediaRequestStatus.APPROVED,
      })
    );

    await getRepository(Media).update(media.id, {
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
      ...overrides,
    });

    return getRepository(Media).findOneOrFail({ where: { id: media.id } });
  };

  /**
   * Sets the operator's auto-approval switch.
   *
   * Written into the injected settings map rather than through a route, because
   * there is no longer a route: it is a declared setting an admin edits on the
   * host's own page. `sdk.settings.own` is a live getter, so a write here is
   * visible to the next request without reactivating.
   */
  const setAutoApprove = (value: boolean): void => {
    settingValues.auto_approve_unavailable = value;
  };

  const reloadMedia = async (id: number): Promise<Media> =>
    getRepository(Media).findOneOrFail({ where: { id } });

  it('refuses a user who does not hold the request permission', async () => {
    const media = await seedRequestedMovie();
    const friend = await userId('friend@seerr.dev');
    granted.set(friend, new Set());

    const response = await call('post', '/requests', {
      user: { id: friend },
      body: { mediaId: media.id },
    });

    assert.equal(response.status, 403);
  });

  it('refuses a caller who does not own a request for the media', async () => {
    // No core request for this media at all, so `friend` has nothing to unrequest.
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 680,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const response = await call('post', '/requests', {
      user: { id: await userId('friend@seerr.dev') },
      body: { mediaId: media.id },
    });

    assert.equal(response.status, 403);
  });

  it('404s for media that does not exist', async () => {
    const response = await call('post', '/requests', {
      user: { id: await userId('friend@seerr.dev') },
      body: { mediaId: 9999 },
    });

    assert.equal(response.status, 404);
  });

  it('refuses media already flagged DELETED', async () => {
    const media = await seedRequestedMovie({ status: MediaStatus.DELETED });

    const response = await call('post', '/requests', {
      user: { id: await userId('friend@seerr.dev') },
      body: { mediaId: media.id },
    });

    assert.equal(response.status, 400);
  });

  it('refuses media whose variant status is UNKNOWN', async () => {
    const media = await seedRequestedMovie({ status: MediaStatus.AVAILABLE });

    // The 4K variant was never requested, so there is nothing there to remove.
    const response = await call('post', '/requests', {
      user: { id: await userId('friend@seerr.dev') },
      body: { mediaId: media.id, is4k: true },
    });

    assert.equal(response.status, 400);
  });

  it('opens a pending request and notifies with the pending key', async () => {
    const media = await seedRequestedMovie();
    const friend = await userId('friend@seerr.dev');

    const response = await call('post', '/requests', {
      user: { id: friend },
      body: { mediaId: media.id },
    });

    assert.equal(response.status, 201);
    const row = response.body as { id: number; status: number };
    assert.equal(row.status, MediaRequestStatus.PENDING);
    assert.deepEqual(
      sent.map((notification) => notification.key),
      ['pending']
    );
    // Available media with the setting off must not be touched.
    assert.deepEqual(removeMovieCalls, []);
  });

  it('rejects a duplicate pending request for the same media and variant', async () => {
    const media = await seedRequestedMovie();
    const friend = await userId('friend@seerr.dev');

    assert.equal(
      (
        await call('post', '/requests', {
          user: { id: friend },
          body: { mediaId: media.id },
        })
      ).status,
      201
    );

    const duplicate = await call('post', '/requests', {
      user: { id: friend },
      body: { mediaId: media.id },
    });

    assert.equal(duplicate.status, 409);
  });

  /**
   * The property the split between the two audiences rests on: nothing a
   * *requester's* click does deletes a file, and holding `manage` does not change
   * that on the request path.
   *
   * `manage` used to auto-approve its holder's own request, on the reasoning that
   * making an approver approve themselves was ceremony. The cost was that an
   * admin's removal never appeared in the queue that is supposed to record what was
   * deleted and who decided it. One extra click buys an audit trail with no holes.
   */
  it('marks even a manage holder’s own request for review', async () => {
    const media = await seedRequestedMovie();
    // The admin needs a core request of their own: the ownership rule now applies
    // to every caller, approver included.
    await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MOVIE,
        media,
        requestedBy: await getRepository(User).findOneOrFail({
          where: { email: 'admin@seerr.dev' },
        }),
        status: MediaRequestStatus.APPROVED,
      })
    );

    const response = await call('post', '/requests', {
      user: { id: await userId('admin@seerr.dev') },
      body: { mediaId: media.id },
    });

    assert.equal(response.status, 201);
    assert.equal(
      (response.body as { status: number }).status,
      MediaRequestStatus.PENDING
    );
    // The point of the test: no deletion, and the media untouched.
    assert.deepEqual(removeMovieCalls, []);
    assert.equal((await reloadMedia(media.id)).status, MediaStatus.AVAILABLE);
    assert.deepEqual(
      sent.map((notification) => notification.key),
      ['pending']
    );
    // Nobody has decided it yet, so nobody is attributed.
    assert.equal(
      (response.body as { modifiedById: unknown }).modifiedById,
      null
    );
  });

  it('refuses a manage holder a removal of media they did not request', async () => {
    // Requested by `friend` only, per `seedRequestedMovie`. Holding `manage` is
    // the power to approve, not a licence to open requests against anything.
    const media = await seedRequestedMovie();

    const response = await call('post', '/requests', {
      user: { id: await userId('admin@seerr.dev') },
      body: { mediaId: media.id },
    });

    assert.equal(response.status, 403);
    assert.deepEqual(removeMovieCalls, []);
  });

  it('auto-approves via the operator setting when the media is not available', async () => {
    setAutoApprove(true);
    const media = await seedRequestedMovie({ status: MediaStatus.PROCESSING });

    const response = await call('post', '/requests', {
      user: { id: await userId('friend@seerr.dev') },
      body: { mediaId: media.id },
    });

    assert.equal(response.status, 201);
    assert.equal(
      (response.body as { status: number }).status,
      MediaRequestStatus.COMPLETED
    );
    assert.deepEqual(removeMovieCalls, [550]);
    // Setting-driven approval has no decision-maker, so nobody is attributed —
    // naming the requester would misreport who authorized the deletion.
    assert.deepEqual(
      sent.map((notification) => notification.key),
      ['auto_approved', 'approved']
    );
    assert.equal(
      (response.body as { modifiedById: unknown }).modifiedById,
      null
    );
  });

  it('does not auto-approve available media even with the setting on', async () => {
    setAutoApprove(true);
    const media = await seedRequestedMovie({ status: MediaStatus.AVAILABLE });

    const response = await call('post', '/requests', {
      user: { id: await userId('friend@seerr.dev') },
      body: { mediaId: media.id },
    });

    assert.equal(
      (response.body as { status: number }).status,
      MediaRequestStatus.PENDING
    );
    assert.deepEqual(removeMovieCalls, []);
    assert.equal((await reloadMedia(media.id)).status, MediaStatus.AVAILABLE);
  });

  it('declares the auto-approval switch as an operator setting, defaulting off', async () => {
    // Read off the manifest rather than a route: the switch has no extension route
    // at all any more, and this is the declaration the host renders a form from.
    // `default: false` is the load-bearing part — an install that never opens the
    // settings page must never delete anything without review.
    const declared = JSON.parse(
      await fs.readFile(
        path.join(EXAMPLE_DIRECTORY, 'seerr-extension.json'),
        'utf8'
      )
    ) as {
      provides: {
        settings: { key: string; type: string; default?: unknown }[];
      };
    };

    assert.deepEqual(declared.provides.settings, [
      {
        key: 'auto_approve_unavailable',
        type: 'boolean',
        name: 'Approve removals of unavailable media without review',
        description:
          'While this is on, a removal request for media that is not available yet is carried out the moment it is made. Media that is already available always needs approval, whatever this is set to.',
        default: false,
      },
    ]);
  });

  it('exposes no route of its own for the operator setting', () => {
    // The switch is `ADMIN`-gated on the host's settings page. An extension route
    // for it would be reachable with only `manage`, which is a weaker gate on the
    // same decision — and writable by the extension, which is what moving it out of
    // kv was for.
    assert.deepEqual(
      registry
        .routesFor('media-removal')
        .filter((route) => route.path.startsWith('/settings')),
      []
    );
  });

  it('offers a requester exactly their own requests to remove', async () => {
    const media = await seedRequestedMovie();
    // A second title `friend` never requested, which must not be offered.
    await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 680,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const response = await call('get', '/removable', {
      user: { id: await userId('friend@seerr.dev') },
    });

    assert.equal(response.status, 200);
    assert.deepEqual((response.body as { results: unknown[] }).results, [
      {
        mediaId: media.id,
        is4k: false,
        mediaType: 'movie',
        available: true,
        removed: false,
        tracked: true,
        removalRequested: false,
        // The picker offers a title, not an id, from the same `getDetails` the
        // rows use — so a title shown in the picker and in the list reads the
        // same and neither needs a second source.
        media: {
          tmdbId: 550,
          mediaType: 'movie',
          title: 'Fight Club',
          year: 1999,
          overview: 'A ticking-time-bomb insomniac.',
          posterUrl:
            'https://image.tmdb.org/t/p/w600_and_h900_bestv2/poster.jpg',
          backdropUrl:
            'https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/backdrop.jpg',
        },
      },
    ]);
  });

  it('flags an entry a removal request is already open for', async () => {
    const media = await seedRequestedMovie();
    const friend = await userId('friend@seerr.dev');

    await call('post', '/requests', {
      user: { id: friend },
      body: { mediaId: media.id },
    });

    const response = await call('get', '/removable', {
      user: { id: friend },
    });

    // Flagged rather than omitted, so the panel can say "already requested"
    // instead of silently dropping a title the user is looking for.
    assert.deepEqual(
      (
        response.body as { results: { removalRequested: boolean }[] }
      ).results.map((entry) => entry.removalRequested),
      [true]
    );
  });

  it('does not offer an approver another user’s requests', async () => {
    // Requested by `friend`. `manage` is the power to approve what is in the queue,
    // not to open requests against media the holder never asked for — so the
    // picker must not offer it.
    await seedRequestedMovie();

    const response = await call('get', '/removable', {
      user: { id: await userId('admin@seerr.dev') },
    });

    assert.equal(response.status, 200);
    assert.deepEqual((response.body as { results: unknown[] }).results, []);
  });

  it('refuses the picker to a caller without the request permission', async () => {
    const friend = await userId('friend@seerr.dev');
    granted.set(friend, new Set());

    const response = await call('get', '/removable', { user: { id: friend } });

    assert.equal(response.status, 403);
  });

  it('decorates every row it serves with renderable media details', async () => {
    const media = await seedRequestedMovie();
    const friend = await userId('friend@seerr.dev');

    const created = await call('post', '/requests', {
      user: { id: friend },
      body: { mediaId: media.id },
    });

    // The column is `mediaId`, because that is what a removal takes — and nothing
    // a person recognizes. The extension resolves the title and the poster through
    // `sdk.media.getDetails` because it is the *backend*: a panel is optional, so
    // a route that served only ids would leave a UI-less consumer with nothing to
    // show and push TMDB's URL conventions into every panel that had one.
    //
    // Asserted on the create, the list and the single read alike, since a client
    // that got details from only one of them would render an unadorned row after
    // every action.
    const detailsOf = (body: unknown) =>
      (body as { media: { title: string; tmdbId: number; posterUrl: string } })
        .media;

    assert.equal(detailsOf(created.body).title, 'Fight Club');
    assert.equal(detailsOf(created.body).tmdbId, 550);
    // A finished URL, not a TMDB path: usable as an `<img src>` unchanged.
    assert.match(detailsOf(created.body).posterUrl, /\/poster\.jpg$/);

    const id = (created.body as { id: number }).id;

    const list = await call('get', '/requests', { user: { id: friend } });
    assert.deepEqual(
      (list.body as { results: { media: { title: string } }[] }).results.map(
        (row) => row.media.title
      ),
      ['Fight Club']
    );

    const single = await call('get', '/requests/:id', {
      user: { id: friend },
      params: { id: String(id) },
    });
    assert.equal(detailsOf(single.body).title, 'Fight Club');
  });

  it('names the requester on the row rather than leaving a bare id', async () => {
    const media = await seedRequestedMovie();
    const friend = await userId('friend@seerr.dev');

    const created = await call('post', '/requests', {
      user: { id: friend },
      body: { mediaId: media.id },
    });

    // Same reasoning as the media details: resolved by the extension through
    // `sdk.users.get`, not by a panel reading core's user API.
    const requestedBy = (
      created.body as { requestedBy: { id: number; displayName: string } }
    ).requestedBy;

    assert.equal(requestedBy.id, friend);
    assert.equal(requestedBy.displayName, 'friend');
    // Nobody has decided yet, so there is no second name to show.
    assert.equal((created.body as { modifiedBy: unknown }).modifiedBy, null);
  });

  it('serves null media for a row whose media is gone', async () => {
    const media = await seedRequestedMovie();
    const friend = await userId('friend@seerr.dev');

    const created = await call('post', '/requests', {
      user: { id: friend },
      body: { mediaId: media.id },
    });

    // The rows hold plain integers rather than relations, so a media row can
    // vanish and leave the request behind — deliberately, since the request is the
    // record that a deletion happened. Serving `null` lets a client say so;
    // dropping the row would destroy the only evidence.
    await getRepository(Media).delete({ id: media.id });

    const single = await call('get', '/requests/:id', {
      user: { id: friend },
      params: { id: String((created.body as { id: number }).id) },
    });

    assert.equal(single.status, 200);
    assert.equal((single.body as { media: unknown }).media, null);
  });

  it('still serves the row when TMDB cannot be reached', async () => {
    const media = await seedRequestedMovie();
    const friend = await userId('friend@seerr.dev');

    tmdbError = new Error('tmdb unreachable');

    try {
      const created = await call('post', '/requests', {
        user: { id: friend },
        body: { mediaId: media.id },
      });

      // The whole reason `getDetails` resolves `null` instead of rejecting: a
      // metadata outage must not take out the route that was merely decorating
      // its response. The request was still opened.
      assert.equal(created.status, 201);
      assert.equal((created.body as { media: unknown }).media, null);
      assert.equal((created.body as { mediaId: number }).mediaId, media.id);
    } finally {
      tmdbError = undefined;
    }
  });

  it('drives the removal from the approve route and reaches COMPLETED', async () => {
    const media = await seedRequestedMovie();
    const created = await call('post', '/requests', {
      user: { id: await userId('friend@seerr.dev') },
      body: { mediaId: media.id },
    });
    const id = String((created.body as { id: number }).id);
    sent = [];

    const approved = await call('post', '/requests/:id/:status', {
      user: { id: await userId('admin@seerr.dev') },
      params: { id, status: 'approve' },
    });

    assert.equal(approved.status, 200);
    assert.equal(
      (approved.body as { status: number }).status,
      MediaRequestStatus.COMPLETED
    );
    assert.deepEqual(removeMovieCalls, [550]);
    assert.equal((await reloadMedia(media.id)).status, MediaStatus.DELETED);
    assert.deepEqual(
      sent.map((notification) => notification.key),
      ['approved']
    );
    assert.equal(
      (approved.body as { modifiedById: number }).modifiedById,
      await userId('admin@seerr.dev')
    );
  });

  /**
   * Approving a request that has already been carried out must not delete
   * anything a second time.
   *
   * The guard cannot be "was this row APPROVED before?", which is the obvious
   * reading of the transition: a successful removal settles the row to COMPLETED,
   * so a second `approve` sees a row that was *not* APPROVED and would call
   * `sdk.media.remove` again — on media core has already flagged DELETED. Core
   * swallows the arr's 404, so that second call is silent rather than an error,
   * which is exactly why it needs a test rather than a comment.
   */
  it('does not remove twice when a settled request is approved again', async () => {
    const media = await seedRequestedMovie();
    const created = await call('post', '/requests', {
      user: { id: await userId('friend@seerr.dev') },
      body: { mediaId: media.id },
    });
    const id = String((created.body as { id: number }).id);
    const admin = { id: await userId('admin@seerr.dev') };

    await call('post', '/requests/:id/:status', {
      user: admin,
      params: { id, status: 'approve' },
    });
    assert.deepEqual(removeMovieCalls, [550]);
    sent = [];

    const again = await call('post', '/requests/:id/:status', {
      user: admin,
      params: { id, status: 'approve' },
    });

    assert.equal(again.status, 200);
    assert.equal(
      (again.body as { status: number }).status,
      MediaRequestStatus.COMPLETED
    );
    // The assertion that matters: still one call, not two.
    assert.deepEqual(removeMovieCalls, [550]);
    assert.deepEqual(sent, []);
  });

  it('leaves the media untouched and the row FAILED when the arr call fails', async () => {
    removeMovieImpl = async () => {
      throw new Error('Radarr said no');
    };
    const media = await seedRequestedMovie();
    const created = await call('post', '/requests', {
      user: { id: await userId('friend@seerr.dev') },
      body: { mediaId: media.id },
    });
    const id = String((created.body as { id: number }).id);
    sent = [];

    const approved = await call('post', '/requests/:id/:status', {
      user: { id: await userId('admin@seerr.dev') },
      params: { id, status: 'approve' },
    });

    assert.equal(
      (approved.body as { status: number }).status,
      MediaRequestStatus.FAILED
    );
    // The half-removed state is the one that matters: core saves the `Media` row
    // only after the arr call returns, so a failure must leave it as it was.
    assert.equal((await reloadMedia(media.id)).status, MediaStatus.AVAILABLE);
    assert.deepEqual(
      sent.map((notification) => notification.key),
      ['failed']
    );
    assert.match(String(sent[0].payload.message), /Radarr said no/);
  });

  it('reports a missing Servarr server as a configuration problem', async () => {
    getSettings().radarr = [];
    const media = await seedRequestedMovie();
    const created = await call('post', '/requests', {
      user: { id: await userId('friend@seerr.dev') },
      body: { mediaId: media.id },
    });
    const id = String((created.body as { id: number }).id);
    sent = [];

    const approved = await call('post', '/requests/:id/:status', {
      user: { id: await userId('admin@seerr.dev') },
      params: { id, status: 'approve' },
    });

    assert.equal(
      (approved.body as { status: number }).status,
      MediaRequestStatus.FAILED
    );
    // `NoServarrServerError` is told apart by its `arrName` property, because an
    // extension cannot import the class from `@server/*`. The distinction is
    // worth surfacing: no configured server is the operator's problem and
    // retrying will not help.
    assert.match(String(sent[0].payload.message), /No Radarr server/i);
  });

  it('declines without removing anything', async () => {
    const media = await seedRequestedMovie();
    const created = await call('post', '/requests', {
      user: { id: await userId('friend@seerr.dev') },
      body: { mediaId: media.id },
    });
    sent = [];

    const declined = await call('post', '/requests/:id/:status', {
      user: { id: await userId('admin@seerr.dev') },
      params: {
        id: String((created.body as { id: number }).id),
        status: 'decline',
      },
    });

    assert.equal(
      (declined.body as { status: number }).status,
      MediaRequestStatus.DECLINED
    );
    assert.deepEqual(removeMovieCalls, []);
    assert.deepEqual(
      sent.map((notification) => notification.key),
      ['declined']
    );
  });

  it('400s an unknown status rather than writing undefined', async () => {
    const media = await seedRequestedMovie();
    const created = await call('post', '/requests', {
      user: { id: await userId('friend@seerr.dev') },
      body: { mediaId: media.id },
    });
    const id = String((created.body as { id: number }).id);

    const response = await call('post', '/requests/:id/:status', {
      user: { id: await userId('admin@seerr.dev') },
      params: { id, status: 'destroy' },
    });

    assert.equal(response.status, 400);

    // The row is untouched, which is the half of this that #9's spec called out:
    // core's equivalent switch has no `default` and writes `undefined` into the
    // status column.
    const read = await call('get', '/requests/:id', {
      user: { id: await userId('admin@seerr.dev') },
      params: { id },
    });
    assert.equal(
      (read.body as { status: number }).status,
      MediaRequestStatus.PENDING
    );
  });

  it('refuses the status route to a caller without manage', async () => {
    const media = await seedRequestedMovie();
    const friend = await userId('friend@seerr.dev');
    const created = await call('post', '/requests', {
      user: { id: friend },
      body: { mediaId: media.id },
    });

    const response = await call('post', '/requests/:id/:status', {
      user: { id: friend },
      params: {
        id: String((created.body as { id: number }).id),
        status: 'approve',
      },
    });

    assert.equal(response.status, 403);
  });

  it('lets the owner withdraw a pending request, but not an approved one', async () => {
    const media = await seedRequestedMovie();
    const friend = await userId('friend@seerr.dev');
    const first = await call('post', '/requests', {
      user: { id: friend },
      body: { mediaId: media.id },
    });

    const withdrawn = await call('delete', '/requests/:id', {
      user: { id: friend },
      params: { id: String((first.body as { id: number }).id) },
    });

    assert.equal(withdrawn.status, 204);

    // A second request, taken through approval, is no longer the owner's to
    // withdraw — the files are already gone.
    const second = await call('post', '/requests', {
      user: { id: friend },
      body: { mediaId: media.id },
    });
    const id = String((second.body as { id: number }).id);
    await call('post', '/requests/:id/:status', {
      user: { id: await userId('admin@seerr.dev') },
      params: { id, status: 'approve' },
    });

    const refused = await call('delete', '/requests/:id', {
      user: { id: friend },
      params: { id },
    });

    assert.equal(refused.status, 403);

    // Someone holding `manage` can still clear it.
    const removed = await call('delete', '/requests/:id', {
      user: { id: await userId('admin@seerr.dev') },
      params: { id },
    });
    assert.equal(removed.status, 204);
  });

  it('shows a caller only their own rows unless they hold manage', async () => {
    const media = await seedRequestedMovie();
    const friend = await userId('friend@seerr.dev');
    const admin = await userId('admin@seerr.dev');

    await call('post', '/requests', {
      user: { id: friend },
      body: { mediaId: media.id },
    });

    const own = await call('get', '/requests', { user: { id: friend } });
    assert.equal((own.body as { results: unknown[] }).results.length, 1);

    // The admin has no rows of their own, and sees the friend's.
    const all = await call('get', '/requests', { user: { id: admin } });
    assert.equal((all.body as { results: unknown[] }).results.length, 1);

    // Revoking `manage` hides it again.
    granted.set(admin, new Set(['request']));
    const scoped = await call('get', '/requests', { user: { id: admin } });
    assert.equal((scoped.body as { results: unknown[] }).results.length, 0);
  });

  it('paginates, and caps an unreasonable take', async () => {
    const media = await seedRequestedMovie();
    const friend = await userId('friend@seerr.dev');
    await call('post', '/requests', {
      user: { id: friend },
      body: { mediaId: media.id },
    });

    const capped = await call('get', '/requests', {
      user: { id: friend },
      query: { take: '5000' },
    });

    assert.equal(capped.status, 200);
    assert.equal(
      (capped.body as { pageInfo: { pageSize: number } }).pageInfo.pageSize,
      100
    );

    const skipped = await call('get', '/requests', {
      user: { id: friend },
      query: { skip: '1' },
    });
    assert.equal((skipped.body as { results: unknown[] }).results.length, 0);
  });

  it('refuses one user’s row to another without manage', async () => {
    const media = await seedRequestedMovie();
    const friend = await userId('friend@seerr.dev');
    const admin = await userId('admin@seerr.dev');
    const created = await call('post', '/requests', {
      user: { id: friend },
      body: { mediaId: media.id },
    });
    const id = String((created.body as { id: number }).id);

    granted.set(admin, new Set(['request']));

    const refused = await call('get', '/requests/:id', {
      user: { id: admin },
      params: { id },
    });
    assert.equal(refused.status, 403);

    granted.set(admin, new Set(['request', 'manage']));
    const allowed = await call('get', '/requests/:id', {
      user: { id: admin },
      params: { id },
    });
    assert.equal(allowed.status, 200);
  });

  it('404s an id that does not exist', async () => {
    const response = await call('get', '/requests/:id', {
      user: { id: await userId('admin@seerr.dev') },
      params: { id: '4242' },
    });

    assert.equal(response.status, 404);
  });
});
