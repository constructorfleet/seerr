/**
 * Behaviour of the `sdk.media` members that reach outside the database:
 * `remove`, the one member `requires: { media: 'write' }` adds, and `getDetails`,
 * which resolves a media row to something renderable.
 *
 * `loader.test.ts` covers the *gate* — whether a member is on the object for a
 * given access level. This file covers what they do when called, driven through
 * the real loader against the real database so that the thing under test is the
 * SDK an extension is actually handed, not a hand-built object shaped like it.
 *
 * The Radarr/Sonarr and TMDB calls are the only fakes. `removeMovie`/
 * `removeSeries` are instance arrow-function properties rather than prototype
 * methods, so `mock.method` cannot swap them; prototype getters delegating to a
 * per-test implementation are the approach `mediaRemoval.test.ts` and
 * `availabilitySync.test.ts` already use.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import Season from '@server/entity/Season';
import {
  activateExtensions,
  discoverExtensions,
} from '@server/lib/extensions/loader';
import type { ExtensionMediaWrite } from '@server/lib/extensions/types';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

setupTestDb();

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

let removeSeriesCalls: number[] = [];
let removeSeriesImpl: (tvdbId: number) => Promise<void> = async () => undefined;

Object.defineProperty(SonarrAPI.prototype, 'removeSeries', {
  get() {
    return async (tvdbId: number) => {
      removeSeriesCalls.push(tvdbId);
      return removeSeriesImpl(tvdbId);
    };
  },
  set() {},
  configurable: true,
});

let tmdbTvdbId: number | undefined;

/**
 * Extra TMDB fields the `getDetails` tests read. Merged over the `external_ids`
 * the removal path needs, so one fake serves both — `getTvShow` is called by
 * `remove` (for the tvdbId) and by `getDetails` (for the metadata).
 */
let tmdbTvShow: Record<string, unknown> = {};
let tmdbMovie: Record<string, unknown> = {};
/** Set to make either lookup reject, standing in for a TMDB outage. */
let tmdbError: Error | undefined;

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  get() {
    return async () => {
      if (tmdbError) {
        throw tmdbError;
      }

      return { external_ids: { tvdb_id: tmdbTvdbId }, ...tmdbTvShow };
    };
  },
  set() {},
  configurable: true,
});

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  get() {
    return async () => {
      if (tmdbError) {
        throw tmdbError;
      }

      return tmdbMovie;
    };
  },
  set() {},
  configurable: true,
});

/** The Radarr/Sonarr servers the removal resolves against. */
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

function buildSonarrSettings(
  overrides: Partial<SonarrSettings> & Pick<SonarrSettings, 'id'>
): SonarrSettings {
  return {
    name: `Sonarr ${overrides.id}`,
    hostname: 'localhost',
    port: 8989,
    apiKey: 'sonarr-key',
    useSsl: false,
    activeProfileId: 1,
    activeProfileName: 'HD',
    activeDirectory: '/tv',
    activeLanguageProfileId: 1,
    tags: [],
    is4k: false,
    isDefault: true,
    syncEnabled: false,
    preventSearch: false,
    tagRequests: false,
    overrideRule: [],
    seriesType: 'standard',
    animeSeriesType: 'anime',
    enableSeasonFolders: true,
    monitorNewItems: 'all',
    ...overrides,
  };
}

/**
 * Its own global, not `loader.test.ts`'s `__seerrExtensionTest`: the suite
 * typechecks every test file together, and two `declare global` blocks naming
 * the same variable are a redeclaration error even when the types agree.
 */
declare global {
  var __seerrSdkMediaTest:
    | { sdks: Record<string, { media?: ExtensionMediaWrite }> }
    | undefined;
}

let directory: string;

/**
 * Activates a one-file extension requiring the given media access level and
 * returns the `media` capability it was handed.
 *
 * Written as a fixture on disk rather than by calling `buildSdk` directly,
 * because `buildSdk` is deliberately not exported: the manifest is the input
 * that decides what an extension gets, and a test that skipped it would not
 * notice the access level being ignored — which is exactly the bug this member
 * was added alongside.
 */
async function mediaSdk(
  access: 'read' | 'write'
): Promise<ExtensionMediaWrite | undefined> {
  const extensionDirectory = path.join(directory, 'demo');
  await fs.mkdir(extensionDirectory, { recursive: true });
  await fs.writeFile(
    path.join(extensionDirectory, 'seerr-extension.json'),
    JSON.stringify({
      id: 'demo',
      name: 'Demo',
      version: '1.0.0',
      apiVersion: '^1.0.0',
      server: 'server.js',
      requires: { media: access },
    })
  );
  await fs.writeFile(
    path.join(extensionDirectory, 'server.js'),
    `const record = (globalThis.__seerrSdkMediaTest ??= { sdks: {} });
module.exports.default = async (sdk) => {
  record.sdks[sdk.id] = sdk;
};
`
  );

  const registry = await discoverExtensions({ directory });
  await activateExtensions(registry);

  const sdk = globalThis.__seerrSdkMediaTest?.sdks.demo;
  assert.ok(sdk, 'expected the demo extension to have been activated');

  return sdk.media;
}

/** A `media` capability known to have `remove`, for the write-access tests. */
async function writableMediaSdk(): Promise<ExtensionMediaWrite> {
  const media = await mediaSdk('write');
  assert.ok(media?.remove, 'expected media write access to grant remove');
  return media;
}

async function saveMovie(overrides?: Partial<Media>): Promise<Media> {
  return getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 550,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
      ...overrides,
    })
  );
}

async function saveSeries(overrides?: Partial<Media>): Promise<Media> {
  return getRepository(Media).save(
    new Media({
      mediaType: MediaType.TV,
      tmdbId: 1399,
      tvdbId: 121361,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
      seasons: [
        new Season({ seasonNumber: 1, status: MediaStatus.AVAILABLE }),
        new Season({ seasonNumber: 2, status: MediaStatus.AVAILABLE }),
      ],
      ...overrides,
    })
  );
}

/** The persisted row, so a test asserts on the write rather than the mutation. */
async function reload(id: number): Promise<Media> {
  const media = await getRepository(Media).findOne({
    where: { id },
    relations: { seasons: true },
  });
  assert.ok(media, `expected media ${id} to still exist`);
  return media;
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'seerr-ext-media-'));
  globalThis.__seerrSdkMediaTest = undefined;

  removeMovieCalls = [];
  removeSeriesCalls = [];
  removeMovieImpl = async () => undefined;
  removeSeriesImpl = async () => undefined;
  tmdbTvdbId = undefined;
  tmdbTvShow = {};
  tmdbMovie = {};
  tmdbError = undefined;

  const settings = getSettings();
  settings.radarr = [
    buildRadarrSettings({ id: 0 }),
    buildRadarrSettings({
      id: 1,
      name: 'Radarr 4K',
      port: 7879,
      activeDirectory: '/movies4k',
      is4k: true,
    }),
  ];
  settings.sonarr = [buildSonarrSettings({ id: 0 })];
});

afterEach(async () => {
  globalThis.__seerrSdkMediaTest = undefined;
  await fs.rm(directory, { recursive: true, force: true });

  const settings = getSettings();
  settings.radarr = [];
  settings.sonarr = [];
});

describe('sdk.media.remove', () => {
  it('removes a movie from Radarr and persists the deleted status', async () => {
    const media = await saveMovie();
    const sdk = await writableMediaSdk();

    await sdk.remove(media.id);

    assert.deepStrictEqual(removeMovieCalls, [550]);
    // Reloaded, not the in-memory entity: unlike `removeMediaFromServarr`, the
    // SDK member owns the save, because an extension has no repository for
    // core's `Media` to save it with.
    assert.strictEqual((await reload(media.id)).status, MediaStatus.DELETED);
  });

  it('removes the 4K variant and leaves the non-4K status alone', async () => {
    const media = await saveMovie({
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.AVAILABLE,
      serviceId4k: 1,
    });
    const sdk = await writableMediaSdk();

    await sdk.remove(media.id, true);

    const reloaded = await reload(media.id);
    assert.strictEqual(reloaded.status4k, MediaStatus.DELETED);
    assert.strictEqual(reloaded.status, MediaStatus.AVAILABLE);
  });

  it('defaults to the non-4K variant when is4k is omitted', async () => {
    const media = await saveMovie({ status4k: MediaStatus.AVAILABLE });
    const sdk = await writableMediaSdk();

    await sdk.remove(media.id);

    const reloaded = await reload(media.id);
    assert.strictEqual(reloaded.status, MediaStatus.DELETED);
    assert.strictEqual(reloaded.status4k, MediaStatus.AVAILABLE);
  });

  it('removes a series from Sonarr and flags every season as deleted', async () => {
    tmdbTvdbId = 999;
    const media = await saveSeries();
    const sdk = await writableMediaSdk();

    await sdk.remove(media.id);

    assert.deepStrictEqual(removeSeriesCalls, [999]);

    const reloaded = await reload(media.id);
    assert.strictEqual(reloaded.status, MediaStatus.DELETED);
    assert.deepStrictEqual(
      reloaded.seasons
        .sort((a, b) => a.seasonNumber - b.seasonNumber)
        .map((season) => season.status),
      [MediaStatus.DELETED, MediaStatus.DELETED]
    );
  });

  it('resets the service data of the removed variant only', async () => {
    const media = await saveMovie({
      serviceId: 0,
      externalServiceId: 11,
      ratingKey: 'rk',
      serviceId4k: 1,
      externalServiceId4k: 22,
      ratingKey4k: 'rk4k',
    });
    const sdk = await writableMediaSdk();

    await sdk.remove(media.id);

    const reloaded = await reload(media.id);
    assert.strictEqual(reloaded.serviceId, null);
    assert.strictEqual(reloaded.externalServiceId, null);
    assert.strictEqual(reloaded.ratingKey, null);
    assert.strictEqual(reloaded.serviceId4k, 1);
    assert.strictEqual(reloaded.externalServiceId4k, 22);
    assert.strictEqual(reloaded.ratingKey4k, 'rk4k');
  });

  it('removes from the server the media was added to, not the default', async () => {
    const settings = getSettings();
    settings.radarr = [
      ...settings.radarr,
      buildRadarrSettings({
        id: 2,
        name: 'Radarr Secondary',
        port: 7880,
        apiKey: 'secondary-key',
        isDefault: false,
      }),
    ];
    const media = await saveMovie({ serviceId: 2 });
    const sdk = await writableMediaSdk();

    // `buildUrl` is the only observable evidence of *which* server was used —
    // the API client is constructed with a URL and the fake `removeMovie` sees
    // only the tmdbId.
    let usedUrl: string | undefined;
    const buildUrl = RadarrAPI.buildUrl;
    RadarrAPI.buildUrl = (settingsArg, endpoint) => {
      usedUrl = buildUrl.call(RadarrAPI, settingsArg, endpoint);
      return usedUrl;
    };

    try {
      await sdk.remove(media.id);
    } finally {
      RadarrAPI.buildUrl = buildUrl;
    }

    // Port 7880 is the secondary server's, so the removal went where the media
    // actually lives rather than to whichever server happens to be default.
    assert.match(String(usedUrl), /:7880\//);
  });

  it('rejects with a clear error when the media does not exist', async () => {
    const sdk = await writableMediaSdk();

    await assert.rejects(() => sdk.remove(9999), /Media 9999 does not exist/);
    // Nothing was attempted against Radarr for a row that is not there.
    assert.deepStrictEqual(removeMovieCalls, []);
  });

  it('surfaces NoServarrServerError when no server is configured', async () => {
    getSettings().radarr = [];
    const media = await saveMovie();
    const sdk = await writableMediaSdk();

    // Propagated rather than wrapped, because an extension has to be able to
    // tell "the operator has no Radarr" (retry later, tell the user) from "the
    // Radarr call failed".
    await assert.rejects(() => sdk.remove(media.id), {
      name: 'Error',
      arrName: 'Radarr',
      message: 'No Radarr server configured to delete media files',
    });
    assert.strictEqual((await reload(media.id)).status, MediaStatus.AVAILABLE);
  });

  it('does not persist a deletion when the arr call fails', async () => {
    removeMovieImpl = async () => {
      throw new Error('radarr exploded');
    };
    const media = await saveMovie();
    const sdk = await writableMediaSdk();

    await assert.rejects(() => sdk.remove(media.id), /radarr exploded/);
    assert.strictEqual((await reload(media.id)).status, MediaStatus.AVAILABLE);
  });

  it('is absent for read-only media access', async () => {
    const media = await mediaSdk('read');

    assert.strictEqual('remove' in (media ?? {}), false);
  });
});

describe('sdk.media.getDetails', () => {
  /** Restored per test, since the image URL form depends on it. */
  let cacheImages: boolean;

  beforeEach(() => {
    cacheImages = getSettings().main.cacheImages;
  });

  afterEach(() => {
    getSettings().main.cacheImages = cacheImages;
  });

  it('flattens a movie into one name per concept', async () => {
    tmdbMovie = {
      title: 'Fight Club',
      release_date: '1999-10-15',
      overview: 'A ticking-time-bomb insomniac.',
      poster_path: '/poster.jpg',
      backdrop_path: '/backdrop.jpg',
    };
    const media = await saveMovie();
    const sdk = await mediaSdk('read');

    const details = await sdk?.getDetails(media.id);

    assert.strictEqual(details?.title, 'Fight Club');
    assert.strictEqual(details?.year, 1999);
    assert.strictEqual(details?.overview, 'A ticking-time-bomb insomniac.');
    assert.strictEqual(details?.tmdbId, 550);
    assert.strictEqual(details?.mediaType, MediaType.MOVIE);
  });

  it("reads a series' name and first-air year under the same field names", async () => {
    // The whole point of the flattened shape: a caller renders both media types
    // with one code path, rather than branching on `title` versus `name`.
    tmdbTvShow = {
      name: 'Game of Thrones',
      first_air_date: '2011-04-17',
      overview: 'Seven noble families fight.',
      poster_path: '/got.jpg',
    };
    const media = await saveSeries();
    const sdk = await mediaSdk('read');

    const details = await sdk?.getDetails(media.id);

    assert.strictEqual(details?.title, 'Game of Thrones');
    assert.strictEqual(details?.year, 2011);
    assert.strictEqual(details?.mediaType, MediaType.TV);
  });

  it('returns proxied image URLs when the operator caches images', async () => {
    getSettings().main.cacheImages = true;
    tmdbMovie = { poster_path: '/poster.jpg', backdrop_path: '/backdrop.jpg' };
    const media = await saveMovie();
    const sdk = await mediaSdk('read');

    const details = await sdk?.getDetails(media.id);

    // Host-relative and above the OpenAPI validator, so a panel can use it as a
    // `src` unchanged — which is the reason this is resolved here and not in a UI.
    assert.strictEqual(
      details?.posterUrl,
      '/imageproxy/tmdb/t/p/w600_and_h900_bestv2/poster.jpg'
    );
    assert.strictEqual(
      details?.backdropUrl,
      '/imageproxy/tmdb/t/p/w1920_and_h800_multi_faces/backdrop.jpg'
    );
  });

  it('returns tmdb.org URLs when image caching is off', async () => {
    getSettings().main.cacheImages = false;
    tmdbMovie = { poster_path: '/poster.jpg' };
    const media = await saveMovie();
    const sdk = await mediaSdk('read');

    const details = await sdk?.getDetails(media.id);

    assert.strictEqual(
      details?.posterUrl,
      'https://image.tmdb.org/t/p/w600_and_h900_bestv2/poster.jpg'
    );
  });

  it('nulls an image URL TMDB has no artwork for', async () => {
    tmdbMovie = { poster_path: null, backdrop_path: undefined };
    const media = await saveMovie();
    const sdk = await mediaSdk('read');

    const details = await sdk?.getDetails(media.id);

    assert.strictEqual(details?.posterUrl, null);
    assert.strictEqual(details?.backdropUrl, null);
  });

  it('defaults a missing overview and an absent date rather than leaking undefined', async () => {
    tmdbMovie = { title: 'Untitled', release_date: '' };
    const media = await saveMovie();
    const sdk = await mediaSdk('read');

    const details = await sdk?.getDetails(media.id);

    assert.strictEqual(details?.overview, '');
    assert.strictEqual(details?.year, null);
  });

  it('resolves null for a media row that does not exist', async () => {
    const sdk = await mediaSdk('read');

    assert.strictEqual(await sdk?.getDetails(9999), null);
  });

  it('resolves null instead of rejecting when TMDB fails', async () => {
    // A metadata outage must not take out the extension route that was merely
    // decorating a response with a title.
    tmdbError = new Error('tmdb unreachable');
    const media = await saveMovie();
    const sdk = await mediaSdk('read');

    assert.strictEqual(await sdk?.getDetails(media.id), null);
  });

  it('is granted by read access, not only write', async () => {
    const media = await mediaSdk('read');

    assert.strictEqual(typeof media?.getDetails, 'function');
  });
});
