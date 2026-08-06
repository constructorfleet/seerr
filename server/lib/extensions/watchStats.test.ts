/**
 * The Watch Stats example extension, loaded the way a real install is.
 *
 * The same integration shape as `watchHistory.test.ts` and for the same reason:
 * `examples/watch-stats` is not part of any tsconfig this suite compiles, and must
 * not be — an extension is built separately, installed into
 * `config/extensions/<id>/`, and `require()`d from disk. So this compiles it with
 * its own `tsc`, copies the output into a directory `discoverExtensions` reads, and
 * drives the result through the real loader.
 *
 * What this example adds over `watch-history`, and therefore what is worth testing
 * here rather than there: it integrates **external services**, one of which core
 * knows about (Tautulli, via `sdk.tautulli`) and one of which it does not
 * (Tracearr, over its own HTTP). So the tests below concentrate on the seams that
 * only exist because of that — resolving a source or explaining its absence, the
 * join from a source's identifiers back to core's media and user rows, and the
 * recompute-and-replace that makes the sync idempotent.
 *
 * Tautulli's HTTP is faked by swapping methods on core's `TautulliAPI` prototype,
 * so what runs is the host capability's real conversion logic. Tracearr's is faked
 * by swapping `globalThis.fetch`, which is what the extension's own adapter calls.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { promisify } from 'node:util';

import TautulliAPI from '@server/api/tautulli';
import { MediaStatus, MediaType } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import {
  activateExtensions,
  discoverExtensions,
  injectExtensionEntities,
} from '@server/lib/extensions/loader';
import { parseManifest } from '@server/lib/extensions/manifest';
import { runExtensionMigrations } from '@server/lib/extensions/migrations';
import type {
  ExtensionRouteRequest,
  ExtensionSettingValue,
} from '@server/lib/extensions/types';
import { setupTestDb } from '@server/test/db';
import buildExtensionSdk from '@server/test/extensionSdkBuild';
import { seedTestDb } from '@server/utils/seedTestDb';
import type { Response } from 'express';

setupTestDb();

const execFileAsync = promisify(execFile);

const EXAMPLE_DIRECTORY = path.join(__dirname, '../../../examples/watch-stats');

const BUILD_TIMEOUT = 180_000;

let directory: string;

/** Plex ids given to the seeded users, so a source can name them. */
const ADMIN_PLEX_ID = 1001;
const FRIEND_PLEX_ID = 1002;

// #region fakes

/** What the faked Tautulli returns, per Plex user id. */
let tautulliHistory: Record<number, unknown[]> = {};
/** Records returned by the faked Tracearr `/history`, and what it was called with. */
let tracearrRecords: unknown[] = [];
let tracearrUrls: string[] = [];
let tracearrAuth: string[] = [];
/** Set to make Tracearr answer with this status instead of data. */
let tracearrStatus: number | undefined;

function fakeTautulli(method: string, results: (arg: unknown) => unknown) {
  Object.defineProperty(TautulliAPI.prototype, method, {
    get() {
      return async (arg: unknown) => results(arg);
    },
    set() {},
    configurable: true,
  });
}

fakeTautulli('getInfo', () => ({ tautulli_version: 'v2.13.4' }));
fakeTautulli('getUserWatchStats', () => ({
  query_days: 0,
  total_time: 0,
  total_plays: 0,
}));
fakeTautulli(
  'getUserWatchHistory',
  (user) => tautulliHistory[(user as { plexId: number }).plexId] ?? []
);

const realFetch = globalThis.fetch;

/** A Tautulli history record. `duration` and `date` are **seconds**. */
const play = (overrides: Record<string, unknown> = {}) => ({
  rating_key: 4021,
  media_type: 'movie',
  title: 'A Movie',
  duration: 5400,
  date: Math.floor(Date.now() / 1000) - 3600,
  user_id: FRIEND_PLEX_ID,
  ...overrides,
});

/** A Tracearr history record. `duration_ms` is **milliseconds**. */
const tracearrPlay = (overrides: Record<string, unknown> = {}) => ({
  tmdb_id: 550,
  media_type: 'movie',
  duration_ms: 5_400_000,
  watched_at: new Date(Date.now() - 3600_000).toISOString(),
  user: { id: FRIEND_PLEX_ID },
  ...overrides,
});

// #endregion

before(async () => {
  // The example's tsconfig resolves `@seerr/extension-sdk` to the package's
  // gitignored `dist/`, so it has to be built before this `tsc` runs.
  await buildExtensionSdk();

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

  // Inside the repository, not `os.tmpdir()`: the built entry point `require`s
  // `zod` by name, and Node resolves that by walking parents for a
  // `node_modules`. From `/var/folders/…` there is none.
  directory = await fs.mkdtemp(path.join(__dirname, '../../../.ext-stats-'));
  await fs.cp(EXAMPLE_DIRECTORY, path.join(directory, 'watch-stats'), {
    recursive: true,
    filter: (source) => !source.includes('node_modules'),
  });

  const sdkLink = path.join(directory, 'watch-stats/node_modules/@seerr');
  await fs.mkdir(sdkLink, { recursive: true });
  await fs.symlink(
    path.join(__dirname, '../../../packages/extension-sdk'),
    path.join(sdkLink, 'extension-sdk'),
    'dir'
  );
});

after(async () => {
  globalThis.fetch = realFetch;
  await fs.rm(directory, { recursive: true, force: true });
});

describe('the watch-stats manifest', () => {
  const readManifest = async () =>
    parseManifest(
      JSON.parse(
        await fs.readFile(
          path.join(EXAMPLE_DIRECTORY, 'seerr-extension.json'),
          'utf8'
        )
      )
    );

  it('is valid against the host schema', async () => {
    const manifest = await readManifest();

    assert.equal(manifest.id, 'watch-stats');
    assert.equal(manifest.requires?.tautulli, 'read');
    assert.equal(manifest.requires?.discover, 'read');
    assert.equal(manifest.requires?.media, 'read');
    assert.equal(manifest.requires?.users, 'read');
    assert.equal(manifest.provides?.settings?.length, 4);
    assert.equal(manifest.provides?.panels?.length, 1);
  });

  it('declares no outbound http allowlist, because it cannot honestly', async () => {
    // Both sources live at an address the *operator* chooses, so there is no
    // hostname the author could list. Asserted rather than merely commented in
    // the manifest, because the tempting fix — a plausible-looking placeholder —
    // would make the field a lie in the one file whose job is to describe
    // truthfully what the extension touches.
    const manifest = await readManifest();

    assert.equal(manifest.requires?.http, undefined);
  });

  it('agrees with the TypeScript manifest the entry point narrows from', async () => {
    // Two copies exist because `resolveJsonModule` widens as it infers, so an
    // imported JSON manifest narrows nothing in `defineExtension`. This is what
    // keeps them honest; see the same test in `watchHistory.test.ts`.
    const raw = JSON.parse(
      await fs.readFile(
        path.join(EXAMPLE_DIRECTORY, 'seerr-extension.json'),
        'utf8'
      )
    );

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { manifest } = require(
      path.join(EXAMPLE_DIRECTORY, 'dist/manifest.js')
    ) as { manifest: unknown };

    assert.deepEqual(raw, manifest);
  });

  it('ships the built panel bundle its manifest names', async () => {
    const manifest = await readManifest();
    const entry = manifest.provides?.panels?.[0].entry as string;

    await fs.access(path.join(EXAMPLE_DIRECTORY, entry));
  });

  it('emits a panel bundle that only imports host-shared specifiers', async () => {
    // An unmapped bare specifier does not fail loudly — it resolves to a second
    // copy of the package, which renders and then breaks on the first hook.
    const manifest = await readManifest();
    const entry = manifest.provides?.panels?.[0].entry as string;
    const bundle = await fs.readFile(
      path.join(EXAMPLE_DIRECTORY, entry),
      'utf8'
    );

    const specifiers = [...bundle.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1]
    );

    assert.ok(specifiers.length, 'the bundle imports nothing at all');

    const { SHARED_MODULE_SPECIFIERS } =
      await import('@server/lib/extensions/sharedModuleSpecifiers');

    for (const specifier of specifiers) {
      assert.ok(
        (SHARED_MODULE_SPECIFIERS as readonly string[]).includes(specifier),
        `panel bundle imports "${specifier}", which the host import map does not provide`
      );
    }
  });
});

describe('the watch-stats migration', () => {
  it('runs, and creates only tables inside its own namespace', async () => {
    const registry = await discoverExtensions({ directory });
    const entry = registry.all()[0];

    assert.equal(
      entry.migrations.length,
      1,
      'the migration is not reaching the loader as a module export'
    );

    // A scratch DataSource, so this is the migration path a production install
    // takes rather than the `synchronize: true` path the behaviour suite uses.
    // The host's prefix guard wraps the QueryRunner, so a statement touching a
    // table outside `ext_watch-stats_` is refused here.
    const results = await runExtensionMigrations(
      [{ id: entry.id, migrations: entry.migrations }],
      { baseOptions: { type: 'sqlite', database: ':memory:' } }
    );

    assert.equal(results.length, 1);
    assert.equal(results[0].error, undefined, String(results[0].error));
    assert.deepEqual(results[0].migrations, ['CreatePlayStat1786000000000']);
  });
});

/**
 * The extension actually doing its job.
 *
 * Route handlers and the job are pulled off the registry and invoked directly, as
 * in `watchHistory.test.ts`: what is under test is this extension's logic, not the
 * router and scheduler the loader slices already cover.
 */
describe('watch-stats behaviour', () => {
  let registry: Awaited<ReturnType<typeof discoverExtensions>>;
  /** The extension's own settings, mutable per test. */
  let own: Record<string, ExtensionSettingValue>;
  /** What the injected `hasPermission` answers true for. */
  const granted = new Set(['view_own', 'view_all']);
  /** Core media rows, by the key a source would name them with. */
  let movieId: number;
  let seriesId: number;

  before(async () => {
    registry = await discoverExtensions({ directory });

    // Injecting entities appends to the DataSource's *options*; TypeORM builds
    // metadata during `initialize()` and will not rebuild it. This suite's
    // DataSource is already initialized, so it has to be cycled — and re-seeded,
    // because the database is `:memory:`.
    injectExtensionEntities(dataSource, registry);
    await dataSource.destroy();
    await seedTestDb();

    await activateExtensions(registry, {
      runMigrations: false,
      hasPermission: async (_extensionId, _forUser, permission) =>
        granted.has(String(permission)),
      getSettingValues: () => own,
      getTautulliSettings: () => ({
        hostname: 'tautulli.local',
        port: 8181,
        apiKey: 'tautulli-secret',
      }),
    });

    assert.equal(registry.all()[0].status, 'active', registry.all()[0].error);
  });

  beforeEach(async () => {
    granted.add('view_own');
    granted.add('view_all');
    own = { source: 'tautulli', trend_days: 7 };
    tautulliHistory = {};
    tracearrRecords = [];
    tracearrUrls = [];
    tracearrAuth = [];
    tracearrStatus = undefined;

    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      tracearrUrls.push(String(url));
      tracearrAuth.push(
        String((init?.headers as Record<string, string>)?.Authorization ?? '')
      );

      if (tracearrStatus) {
        return {
          ok: false,
          status: tracearrStatus,
          statusText: 'Nope',
        } as unknown as globalThis.Response;
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ data: tracearrRecords, meta: {} }),
      } as unknown as globalThis.Response;
    }) as typeof globalThis.fetch;

    // The users a source can name. Plex ids are the only bridge from a play
    // record back to a Seerr user, so without these nothing joins.
    const users = getRepository(User);
    const admin = await users.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    admin.plexId = ADMIN_PLEX_ID;
    const friend = await users.findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    friend.plexId = FRIEND_PLEX_ID;
    await users.save([admin, friend]);

    // Two media rows: one findable by rating key (Tautulli's identifier), one by
    // tmdbId (Tracearr's).
    const media = getRepository(Media);
    const movie = await media.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 550,
        status: MediaStatus.AVAILABLE,
        ratingKey: '4021',
      })
    );
    movieId = movie.id;
    const series = await media.save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 1399,
        status: MediaStatus.AVAILABLE,
        ratingKey: '8000',
      })
    );
    seriesId = series.id;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const call = async (
    method: 'get' | 'post',
    routePath: string,
    req: { user?: { id: number }; query?: Record<string, string> }
  ): Promise<{ status: number; body: unknown }> => {
    const route = registry
      .routesFor('watch-stats')
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

  const runSync = async (): Promise<void> => {
    const job = registry.jobs().find((entry) => entry.id === 'sync');
    assert.ok(job, 'the sync job is not registered');
    await job.run();
  };

  const userId = async (email: string): Promise<number> =>
    (await getRepository(User).findOneOrFail({ where: { email } })).id;

  it('registers the panel, the job and its three routes', async () => {
    assert.deepEqual(
      registry.panelsFor('watch-stats').map((panel) => panel.slug),
      ['stats']
    );
    assert.deepEqual(
      registry.jobs().map((job) => job.id),
      ['sync']
    );
    assert.deepEqual(
      registry
        .routesFor('watch-stats')
        .map((route) => route.path)
        .sort(),
      ['/stats', '/suggestions', '/trending']
    );
  });

  describe('reading from Tautulli', () => {
    it('joins a play to core media by rating key and to a user by Plex id', async () => {
      // The join this extension exists to do: Tautulli names a title by Plex
      // rating key and a user by Plex id, and neither is a key Seerr stores stats
      // under.
      tautulliHistory[FRIEND_PLEX_ID] = [play()];

      await runSync();

      const friend = await userId('friend@seerr.dev');
      const { body } = await call('get', '/stats', { user: { id: friend } });
      const { results } = body as {
        results: { mediaId: number; plays: number; watchTimeMs: number }[];
      };

      assert.equal(results.length, 1);
      assert.equal(results[0].mediaId, movieId);
      assert.equal(results[0].plays, 1);
      // 5400 Tautulli seconds, arriving as milliseconds — the conversion the host
      // capability does so neither adapter has to.
      assert.equal(results[0].watchTimeMs, 5_400_000);
    });

    it('counts episode plays against the series, not the episode', async () => {
      // Tautulli reports episodes individually and core's `media` row is the
      // series, so twelve episodes are twelve plays of one title.
      tautulliHistory[FRIEND_PLEX_ID] = [
        play({
          rating_key: 9001,
          grandparent_rating_key: 8000,
          media_type: 'episode',
        }),
        play({
          rating_key: 9002,
          grandparent_rating_key: 8000,
          media_type: 'episode',
        }),
      ];

      await runSync();

      const friend = await userId('friend@seerr.dev');
      const { body } = await call('get', '/stats', { user: { id: friend } });
      const { results } = body as {
        results: { mediaId: number; mediaType: string; plays: number }[];
      };

      assert.equal(results.length, 1);
      assert.equal(results[0].mediaId, seriesId);
      assert.equal(results[0].mediaType, 'tv');
      assert.equal(results[0].plays, 2);
    });

    it('drops a play of media Seerr has no row for', async () => {
      // Something added to the library outside Seerr. Every stored row is keyed on
      // a core media id, so there is nothing to store — and a row keyed on a
      // rating key would be unrenderable.
      tautulliHistory[FRIEND_PLEX_ID] = [play({ rating_key: 999_999 })];

      await runSync();

      const friend = await userId('friend@seerr.dev');
      const { body } = await call('get', '/stats', { user: { id: friend } });

      assert.deepEqual((body as { results: unknown[] }).results, []);
    });

    it('drops a play by a media-server user with no Seerr account', async () => {
      // Plenty of people watch without ever signing in to Seerr. Not an error.
      tautulliHistory[7777] = [play({ user_id: 7777 })];

      await runSync();

      const friend = await userId('friend@seerr.dev');
      const { body } = await call('get', '/stats', { user: { id: friend } });

      assert.deepEqual((body as { results: unknown[] }).results, []);
    });

    it('ignores plays older than the configured trending window', async () => {
      own.trend_days = 1;
      tautulliHistory[FRIEND_PLEX_ID] = [
        play({ date: Math.floor(Date.now() / 1000) - 5 * 24 * 60 * 60 }),
      ];

      await runSync();

      const friend = await userId('friend@seerr.dev');
      const { body } = await call('get', '/stats', { user: { id: friend } });

      assert.deepEqual((body as { results: unknown[] }).results, []);
    });
  });

  describe('reading from Tracearr', () => {
    beforeEach(() => {
      own = {
        source: 'tracearr',
        trend_days: 7,
        tracearr_url: 'https://tracearr.example.com/',
        tracearr_token: 'trr_pub_abc',
      };
    });

    it('joins a play to core media by tmdbId', async () => {
      // The identifier Tautulli cannot supply, which is why `SourcePlay` carries
      // either key rather than insisting on one.
      tracearrRecords = [tracearrPlay()];

      await runSync();

      const friend = await userId('friend@seerr.dev');
      const { body } = await call('get', '/stats', { user: { id: friend } });
      const { results } = body as {
        results: { mediaId: number; plays: number; watchTimeMs: number }[];
      };

      assert.equal(results.length, 1);
      assert.equal(results[0].mediaId, movieId);
      // Already milliseconds — no conversion, which is why the shared shape's unit
      // is milliseconds.
      assert.equal(results[0].watchTimeMs, 5_400_000);
    });

    it('sends the bearer token and normalizes a trailing slash away', async () => {
      // A trailing slash on the operator's setting would produce `//api/v2/…`,
      // which some reverse proxies redirect and others 404 — a support ticket
      // whose cause is invisible.
      tracearrRecords = [tracearrPlay()];

      await runSync();

      assert.ok(
        tracearrUrls[0].startsWith(
          'https://tracearr.example.com/api/v2/public/history?'
        ),
        tracearrUrls[0]
      );
      assert.equal(tracearrAuth[0], 'Bearer trr_pub_abc');
    });

    it('skips a record Tracearr could not match to TMDB', async () => {
      tracearrRecords = [tracearrPlay({ tmdb_id: null }), tracearrPlay()];

      await runSync();

      const friend = await userId('friend@seerr.dev');
      const { body } = await call('get', '/stats', { user: { id: friend } });

      assert.equal((body as { results: unknown[] }).results.length, 1);
    });

    it('keeps the previous numbers when Tracearr rejects the token', async () => {
      // The property the transaction in `sync` buys: a failed sync leaves the last
      // good aggregate in place rather than emptying the panel.
      tracearrRecords = [tracearrPlay()];
      await runSync();

      tracearrStatus = 401;
      await runSync();

      const friend = await userId('friend@seerr.dev');
      const { body } = await call('get', '/stats', { user: { id: friend } });

      assert.equal((body as { results: unknown[] }).results.length, 1);
    });

    it('explains an unconfigured Tracearr instead of failing', async () => {
      // The state of every fresh install. The sentence reaches the panel, so it is
      // written for the operator rather than for a log.
      delete own.tracearr_token;

      const friend = await userId('friend@seerr.dev');
      const { body } = await call('get', '/stats', { user: { id: friend } });
      const { source, sourceProblem } = body as {
        source: string | null;
        sourceProblem: string | null;
      };

      assert.equal(source, null);
      assert.match(String(sourceProblem), /Tracearr API token/);
    });
  });

  describe('the sync is idempotent', () => {
    it('running it twice leaves the same counts, not doubled ones', async () => {
      // The property that makes an aggregate the right shape: neither source
      // exposes a stable per-play id, so recompute-and-replace is the only design
      // where a second run on a cron is indistinguishable from the first.
      tautulliHistory[FRIEND_PLEX_ID] = [play()];

      await runSync();
      await runSync();

      const friend = await userId('friend@seerr.dev');
      const { body } = await call('get', '/stats', { user: { id: friend } });
      const { results } = body as { results: { plays: number }[] };

      assert.equal(results.length, 1);
      assert.equal(results[0].plays, 1);
    });

    it('forgets a title the source no longer reports', async () => {
      tautulliHistory[FRIEND_PLEX_ID] = [play()];
      await runSync();

      tautulliHistory[FRIEND_PLEX_ID] = [];
      await runSync();

      const friend = await userId('friend@seerr.dev');
      const { body } = await call('get', '/stats', { user: { id: friend } });

      assert.deepEqual((body as { results: unknown[] }).results, []);
    });
  });

  describe('the routes', () => {
    it('decorates rows with server-resolved titles and posters', async () => {
      // The rule the whole SDK is shaped around: the *backend* resolves what a
      // person recognizes, so a panel is handed a `src` and never TMDB's path
      // conventions. `details` is null here only because TMDB is unreachable in
      // this suite — the point is that the key exists and the panel reads it.
      tautulliHistory[FRIEND_PLEX_ID] = [play()];
      await runSync();

      const friend = await userId('friend@seerr.dev');
      const { body } = await call('get', '/stats', { user: { id: friend } });
      const { results } = body as { results: Record<string, unknown>[] };

      assert.ok('details' in results[0]);
    });

    it('gates another user’s stats on view_all', async () => {
      const friend = await userId('friend@seerr.dev');
      const admin = await userId('admin@seerr.dev');

      const allowed = await call('get', '/stats', {
        user: { id: admin },
        query: { userId: String(friend) },
      });
      assert.equal(allowed.status, 200);

      granted.delete('view_all');

      const refused = await call('get', '/stats', {
        user: { id: admin },
        query: { userId: String(friend) },
      });
      assert.equal(refused.status, 403);
    });

    it('rolls plays up across users for the server-wide trending list', async () => {
      // Two users, one title: the aggregate is two plays by two viewers, which is
      // the number that makes it "trending here" rather than "trending for you".
      tautulliHistory[FRIEND_PLEX_ID] = [play()];
      tautulliHistory[ADMIN_PLEX_ID] = [play({ user_id: ADMIN_PLEX_ID })];

      await runSync();

      const admin = await userId('admin@seerr.dev');
      const { status, body } = await call('get', '/trending', {
        user: { id: admin },
      });

      assert.equal(status, 200);
      const { results } = body as {
        results: { mediaId: number; plays: number; viewers: number }[];
      };
      assert.equal(results.length, 1);
      assert.equal(results[0].mediaId, movieId);
      assert.equal(results[0].plays, 2);
      assert.equal(results[0].viewers, 2);
    });

    it('suggests titles from what was played, deduplicated, capped, and never one already watched', async () => {
      // Deliberately tolerant of TMDB being unreachable: `sdk.discover` resolves
      // `[]` on failure by contract, so this route degrades to "nothing to
      // suggest" rather than breaking, and asserting a non-empty list would make
      // this test fail on a network outage rather than on a bug. Everything that
      // *is* this extension's own logic — the cap, the dedup, the exclusion of
      // watched titles — is asserted unconditionally over whatever came back.
      tautulliHistory[FRIEND_PLEX_ID] = [play()];
      await runSync();

      const friend = await userId('friend@seerr.dev');
      const { status, body } = await call('get', '/suggestions', {
        user: { id: friend },
      });

      assert.equal(status, 200);
      const { results } = body as { results: { tmdbId: number }[] };

      assert.ok(results.length <= 20, `${results.length} suggestions returned`);

      const ids = results.map((result) => result.tmdbId);
      assert.equal(
        new Set(ids).size,
        ids.length,
        'a title was suggested twice'
      );
      // 550 is the movie the seeded play resolved to. Suggesting something back
      // to someone who has already watched it is the one thing this list must
      // never do.
      assert.ok(!ids.includes(550), 'suggested an already-watched title');
    });
  });
});
