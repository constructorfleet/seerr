/**
 * Behaviour of `sdk.media.remove`, the one member `requires: { media: 'write' }`
 * adds.
 *
 * `loader.test.ts` covers the *gate* — whether the member is on the object for a
 * given access level. This file covers what it does when called, driven through
 * the real loader against the real database so that the thing under test is the
 * SDK an extension is actually handed, not a hand-built object shaped like it.
 *
 * The Radarr/Sonarr calls are the only fakes. `removeMovie`/`removeSeries` are
 * instance arrow-function properties rather than prototype methods, so
 * `mock.method` cannot swap them; prototype getters delegating to a per-test
 * implementation are the approach `mediaRemoval.test.ts` and
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

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  get() {
    return async () => ({ external_ids: { tvdb_id: tmdbTvdbId } });
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
