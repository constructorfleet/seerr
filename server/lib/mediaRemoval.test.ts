import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import Media from '@server/entity/Media';
import Season from '@server/entity/Season';
import {
  NoServarrServerError,
  removeMediaFromServarr,
} from '@server/lib/mediaRemoval';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';

// `removeMovie`/`removeSeries` are instance arrow-function properties rather
// than prototype methods, so they cannot be swapped with `mock.method`. Install
// prototype getters that delegate to a per-test implementation, matching the
// approach in availabilitySync.test.ts.
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

function buildRadarrSettings(
  overrides: Partial<RadarrSettings> & Pick<RadarrSettings, 'id'>
): RadarrSettings {
  const defaults: RadarrSettings = {
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
    id: overrides.id,
  };

  return Object.assign(defaults, overrides);
}

function buildSonarrSettings(
  overrides: Partial<SonarrSettings> & Pick<SonarrSettings, 'id'>
): SonarrSettings {
  const defaults: SonarrSettings = {
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
    id: overrides.id,
  };

  return Object.assign(defaults, overrides);
}

function mockTvdbId(tvdbId: number | undefined): void {
  tmdbTvdbId = tvdbId;
}

function buildMovie(overrides?: Partial<Media>): Media {
  return new Media({
    id: 1,
    mediaType: MediaType.MOVIE,
    tmdbId: 550,
    status: MediaStatus.AVAILABLE,
    status4k: MediaStatus.UNKNOWN,
    seasons: [],
    ...overrides,
  });
}

function buildSeries(overrides?: Partial<Media>): Media {
  return new Media({
    id: 2,
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
  });
}

describe('removeMediaFromServarr', () => {
  beforeEach(() => {
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

  afterEach(() => {
    mock.restoreAll();
    const settings = getSettings();
    settings.radarr = [];
    settings.sonarr = [];
  });

  it('removes a movie from Radarr and flags the media as deleted', async () => {
    const media = buildMovie();

    await removeMediaFromServarr(media, false);

    assert.deepStrictEqual(removeMovieCalls, [550]);
    assert.strictEqual(media.status, MediaStatus.DELETED);
  });

  it('leaves the non-4K status untouched when removing the 4K variant', async () => {
    const media = buildMovie({
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.AVAILABLE,
      serviceId4k: 1,
    });

    await removeMediaFromServarr(media, true);

    assert.strictEqual(media.status4k, MediaStatus.DELETED);
    assert.strictEqual(media.status, MediaStatus.AVAILABLE);
  });

  it('removes a series from Sonarr using the tvdbId from TMDB', async () => {
    mockTvdbId(999);
    const media = buildSeries();

    await removeMediaFromServarr(media, false);

    assert.deepStrictEqual(removeSeriesCalls, [999]);
    assert.strictEqual(media.status, MediaStatus.DELETED);
  });

  it('falls back to the stored tvdbId when TMDB has none', async () => {
    mockTvdbId(undefined);

    await removeMediaFromServarr(buildSeries(), false);

    assert.deepStrictEqual(removeSeriesCalls, [121361]);
  });

  it('rejects when no tvdbId can be resolved', async () => {
    mockTvdbId(undefined);

    await assert.rejects(
      () => removeMediaFromServarr(buildSeries({ tvdbId: undefined }), false),
      /TVDB ID not found/
    );
    assert.deepStrictEqual(removeSeriesCalls, []);
  });

  it('flags every season as deleted when removing a series', async () => {
    mockTvdbId(999);
    const media = buildSeries();

    await removeMediaFromServarr(media, false);

    assert.deepStrictEqual(
      media.seasons.map((season) => season.status),
      [MediaStatus.DELETED, MediaStatus.DELETED]
    );
  });

  it('resets the service data for the removed variant only', async () => {
    const media = buildMovie({
      serviceId: 0,
      externalServiceId: 11,
      ratingKey: 'rk',
      serviceId4k: 1,
      externalServiceId4k: 22,
      ratingKey4k: 'rk4k',
    });

    await removeMediaFromServarr(media, false);

    assert.strictEqual(media.serviceId, null);
    assert.strictEqual(media.externalServiceId, null);
    assert.strictEqual(media.ratingKey, null);
    assert.strictEqual(media.serviceId4k, 1);
    assert.strictEqual(media.externalServiceId4k, 22);
    assert.strictEqual(media.ratingKey4k, 'rk4k');
  });

  it('prefers the server the media was added to over the default', async () => {
    const settings = getSettings();
    settings.radarr = [
      ...settings.radarr,
      buildRadarrSettings({
        id: 2,
        name: 'Radarr Secondary',
        port: 7880,
        isDefault: false,
      }),
    ];
    const buildUrl = mock.method(RadarrAPI, 'buildUrl');

    await removeMediaFromServarr(buildMovie({ serviceId: 2 }), false);

    assert.strictEqual(buildUrl.mock.callCount(), 1);
    assert.strictEqual(buildUrl.mock.calls[0].arguments[0].id, 2);
  });

  it('throws NoServarrServerError when no server is configured', async () => {
    const settings = getSettings();
    settings.radarr = [];
    const media = buildMovie();

    await assert.rejects(() => removeMediaFromServarr(media, false), {
      name: 'Error',
      arrName: 'Radarr',
      message: 'No Radarr server configured to delete media files',
    });
    assert.strictEqual(media.status, MediaStatus.AVAILABLE);
  });

  it('names the 4K service in NoServarrServerError', async () => {
    const settings = getSettings();
    settings.radarr = [];

    await assert.rejects(
      () => removeMediaFromServarr(buildMovie(), true),
      (e: unknown) =>
        e instanceof NoServarrServerError && e.arrName === '4K Radarr'
    );
  });

  it('does not flag the media as deleted when the arr call fails', async () => {
    removeMovieImpl = async () => {
      throw new Error('radarr exploded');
    };
    const media = buildMovie();

    await assert.rejects(
      () => removeMediaFromServarr(media, false),
      /radarr exploded/
    );
    assert.strictEqual(media.status, MediaStatus.AVAILABLE);
  });
});
