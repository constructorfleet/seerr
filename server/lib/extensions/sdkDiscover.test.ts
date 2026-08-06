/**
 * Behaviour of `sdk.discover`, the capability `requires: { discover: 'read' }`
 * grants: TMDB lookups that are not tied to a row in core's `media` table.
 *
 * Driven through the real loader against a fixture on disk, for the reason
 * `sdkMedia.test.ts` gives: the manifest is the input that decides what an
 * extension is handed, and a test that built the SDK directly would not notice
 * the gate being ignored.
 *
 * TMDB is the only fake. The client's methods are a mix of prototype methods
 * (`getMovieRecommendations`) and instance arrow-function properties
 * (`getAllTrending`), so `mock.method` cannot swap all of them uniformly —
 * prototype getters delegating to per-test state are what the rest of the
 * extension suite uses.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import {
  activateExtensions,
  discoverExtensions,
} from '@server/lib/extensions/loader';
import type { ExtensionDiscover } from '@server/lib/extensions/types';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

setupTestDb();

/** What each faked TMDB method resolves, and what it was called with. */
let trendingResults: unknown[] = [];
let recommendationResults: unknown[] = [];
let similarResults: unknown[] = [];
let calls: { method: string; args: unknown }[] = [];
/** Set to make every lookup reject, standing in for a TMDB outage. */
let tmdbError: Error | undefined;

function fake(method: string, results: () => unknown[]) {
  Object.defineProperty(TheMovieDb.prototype, method, {
    get() {
      return async (args: unknown) => {
        calls.push({ method, args });

        if (tmdbError) {
          throw tmdbError;
        }

        return {
          page: 1,
          total_pages: 1,
          total_results: 0,
          results: results(),
        };
      };
    },
    set() {},
    configurable: true,
  });
}

fake('getAllTrending', () => trendingResults);
fake('getMovieRecommendations', () => recommendationResults);
fake('getTvRecommendations', () => recommendationResults);
fake('getMovieSimilar', () => similarResults);
fake('getTvSimilar', () => similarResults);

/** Its own global; see the note in `sdkMedia.test.ts` on why not a shared one. */
declare global {
  var __seerrSdkDiscoverTest:
    | { sdks: Record<string, { discover?: ExtensionDiscover }> }
    | undefined;
}

let directory: string;

/**
 * Activates a one-file extension whose manifest `requires` is exactly the given
 * object, and returns the `discover` capability it was handed.
 */
async function discoverSdk(
  requires: Record<string, unknown>
): Promise<ExtensionDiscover | undefined> {
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
      requires,
    })
  );
  await fs.writeFile(
    path.join(extensionDirectory, 'server.js'),
    `const record = (globalThis.__seerrSdkDiscoverTest ??= { sdks: {} });
module.exports.default = async (sdk) => {
  record.sdks[sdk.id] = sdk;
};
`
  );

  const registry = await discoverExtensions({ directory });
  await activateExtensions(registry);

  const sdk = globalThis.__seerrSdkDiscoverTest?.sdks.demo;
  assert.ok(sdk, 'expected the demo extension to have been activated');

  return sdk.discover;
}

/** The capability, asserted present, for the tests about what it returns. */
async function grantedDiscover(): Promise<ExtensionDiscover> {
  const discover = await discoverSdk({ discover: 'read' });
  assert.ok(discover, 'expected discover: read to grant the capability');
  return discover;
}

const movieResult = (overrides: Record<string, unknown> = {}) => ({
  id: 550,
  media_type: 'movie',
  title: 'Fight Club',
  release_date: '1999-10-15',
  overview: 'A ticking-time-bomb insomniac.',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  ...overrides,
});

const tvResult = (overrides: Record<string, unknown> = {}) => ({
  id: 1399,
  media_type: 'tv',
  name: 'Game of Thrones',
  first_air_date: '2011-04-17',
  overview: 'Seven noble families fight.',
  poster_path: '/got.jpg',
  ...overrides,
});

let cacheImages: boolean;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'seerr-ext-discover-'));
  globalThis.__seerrSdkDiscoverTest = undefined;

  trendingResults = [];
  recommendationResults = [];
  similarResults = [];
  calls = [];
  tmdbError = undefined;
  cacheImages = getSettings().main.cacheImages;
});

afterEach(async () => {
  globalThis.__seerrSdkDiscoverTest = undefined;
  getSettings().main.cacheImages = cacheImages;
  await fs.rm(directory, { recursive: true, force: true });
});

describe('sdk.discover gating', () => {
  it('is granted by requires.discover: read', async () => {
    const discover = await discoverSdk({ discover: 'read' });

    assert.strictEqual(typeof discover?.trending, 'function');
    assert.strictEqual(typeof discover?.recommendations, 'function');
    assert.strictEqual(typeof discover?.similar, 'function');
  });

  it('is absent when the manifest does not declare it', async () => {
    // Media access is not discover access: `sdk.media` answers "what does core
    // know about this row", and reaching TMDB for titles core has never heard of
    // is a separate thing for the manifest to be honest about.
    const discover = await discoverSdk({ media: 'read' });

    assert.strictEqual(discover, undefined);
  });
});

describe('sdk.discover.trending', () => {
  it('flattens movies and series into one shape per concept', async () => {
    trendingResults = [movieResult(), tvResult()];
    const discover = await grantedDiscover();

    const results = await discover.trending();

    assert.deepStrictEqual(
      results.map((result) => [result.title, result.year, result.mediaType]),
      [
        ['Fight Club', 1999, MediaType.MOVIE],
        ['Game of Thrones', 2011, MediaType.TV],
      ]
    );
  });

  it('drops person and collection results, which are not titles', async () => {
    trendingResults = [
      { id: 287, media_type: 'person', name: 'Brad Pitt' },
      { id: 1, media_type: 'collection', title: 'A Collection' },
      movieResult(),
    ];
    const discover = await grantedDiscover();

    const results = await discover.trending();

    assert.deepStrictEqual(
      results.map((result) => result.tmdbId),
      [550]
    );
  });

  it('defaults to the week window and passes through the one asked for', async () => {
    const discover = await grantedDiscover();

    await discover.trending();
    await discover.trending({ timeWindow: 'day', page: 3 });

    assert.deepStrictEqual(
      calls.map((call) => call.args),
      [
        { timeWindow: 'week', page: 1 },
        { timeWindow: 'day', page: 3 },
      ]
    );
  });

  it('resolves an empty array instead of rejecting when TMDB fails', async () => {
    // Same contract as `sdk.media.getDetails` resolving null: a caller is
    // decorating a response it could serve without this, so a TMDB outage must
    // not become a broken extension route.
    tmdbError = new Error('tmdb unreachable');
    const discover = await grantedDiscover();

    assert.deepStrictEqual(await discover.trending(), []);
  });

  it('resolves image URLs the operator can actually load', async () => {
    getSettings().main.cacheImages = true;
    trendingResults = [movieResult()];
    const discover = await grantedDiscover();

    const [result] = await discover.trending();

    assert.strictEqual(
      result.posterUrl,
      '/imageproxy/tmdb/t/p/w600_and_h900_bestv2/poster.jpg'
    );
    assert.strictEqual(
      result.backdropUrl,
      '/imageproxy/tmdb/t/p/w1920_and_h800_multi_faces/backdrop.jpg'
    );
  });
});

describe('sdk.discover.recommendations', () => {
  it('asks the movie endpoint for a movie', async () => {
    recommendationResults = [movieResult({ id: 680 })];
    const discover = await grantedDiscover();

    const results = await discover.recommendations(550, 'movie');

    assert.deepStrictEqual(calls, [
      { method: 'getMovieRecommendations', args: { movieId: 550, page: 1 } },
    ]);
    assert.deepStrictEqual(
      results.map((result) => result.tmdbId),
      [680]
    );
  });

  it('asks the tv endpoint for a series, keyed on tvId', async () => {
    // The two endpoints take differently-named parameters; translating between
    // them is exactly what an extension should not have to know.
    recommendationResults = [tvResult({ id: 1396 })];
    const discover = await grantedDiscover();

    await discover.recommendations(1399, 'tv', { page: 2 });

    assert.deepStrictEqual(calls, [
      { method: 'getTvRecommendations', args: { tvId: 1399, page: 2 } },
    ]);
  });

  it('stamps the media type asked for, not the one TMDB echoed', async () => {
    // The recommendation endpoints answer a single type and omit `media_type`
    // from their results, so it cannot be read off the payload.
    recommendationResults = [{ id: 1396, name: 'Breaking Bad' }];
    const discover = await grantedDiscover();

    const [result] = await discover.recommendations(1399, 'tv');

    assert.strictEqual(result.mediaType, MediaType.TV);
    assert.strictEqual(result.title, 'Breaking Bad');
  });

  it('resolves an empty array instead of rejecting when TMDB fails', async () => {
    tmdbError = new Error('tmdb unreachable');
    const discover = await grantedDiscover();

    assert.deepStrictEqual(await discover.recommendations(550, 'movie'), []);
  });
});

describe('sdk.discover.similar', () => {
  it('asks the movie similar endpoint for a movie', async () => {
    similarResults = [movieResult({ id: 807 })];
    const discover = await grantedDiscover();

    const results = await discover.similar(550, 'movie');

    assert.deepStrictEqual(calls, [
      { method: 'getMovieSimilar', args: { movieId: 550, page: 1 } },
    ]);
    assert.deepStrictEqual(
      results.map((result) => result.tmdbId),
      [807]
    );
  });

  it('asks the tv similar endpoint for a series', async () => {
    similarResults = [tvResult({ id: 1400 })];
    const discover = await grantedDiscover();

    await discover.similar(1399, 'tv');

    assert.deepStrictEqual(calls, [
      { method: 'getTvSimilar', args: { tvId: 1399, page: 1 } },
    ]);
  });

  it('resolves an empty array instead of rejecting when TMDB fails', async () => {
    tmdbError = new Error('tmdb unreachable');
    const discover = await grantedDiscover();

    assert.deepStrictEqual(await discover.similar(1399, 'tv'), []);
  });

  it('defaults an absent overview and an unparseable date', async () => {
    similarResults = [
      { id: 1, media_type: 'movie', title: 'Untitled', release_date: '' },
    ];
    const discover = await grantedDiscover();

    const [result] = await discover.similar(550, 'movie');

    assert.strictEqual(result.overview, '');
    assert.strictEqual(result.year, null);
    assert.strictEqual(result.posterUrl, null);
  });
});
