/**
 * Behaviour of `sdk.tautulli`, the capability `requires: { tautulli: 'read' }`
 * grants: watch history from core's configured Tautulli server.
 *
 * Driven through the real loader against a fixture on disk, for the reason
 * `sdkDiscover.test.ts` gives: the manifest is the input that decides what an
 * extension is handed, so a test that built the SDK directly would not notice the
 * gate being ignored.
 *
 * Two things are faked, and the split matters. Tautulli's *HTTP* is faked by
 * swapping the methods on core's `TautulliAPI` prototype, so what is exercised is
 * the host's conversion (seconds → milliseconds, the episode/series key split,
 * the cap) rather than axios. The *settings* are the real settings object, so the
 * "operator has not configured Tautulli" case goes through the same code path a
 * fresh install does.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import TautulliAPI from '@server/api/tautulli';
import {
  activateExtensions,
  discoverExtensions,
} from '@server/lib/extensions/loader';
import type { ExtensionTautulli } from '@server/lib/extensions/types';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

setupTestDb();

/** What each faked Tautulli method resolves, and what it was called with. */
let infoResult: unknown = { tautulli_version: 'v2.13.4' };
let userStatsResult: unknown = { query_days: 0, total_time: 0, total_plays: 0 };
let historyResults: unknown[] = [];
let calls: { method: string; args: unknown[] }[] = [];
/** Set to make every call reject, standing in for a Tautulli outage. */
let tautulliError: Error | undefined;

function fake(method: string, results: () => unknown) {
  Object.defineProperty(TautulliAPI.prototype, method, {
    get() {
      return async (...args: unknown[]) => {
        calls.push({ method, args });

        if (tautulliError) {
          throw tautulliError;
        }

        return results();
      };
    },
    set() {},
    configurable: true,
  });
}

fake('getInfo', () => infoResult);
fake('getUserWatchStats', () => userStatsResult);
fake('getUserWatchHistory', () => historyResults);

declare global {
  var __seerrSdkTautulliTest:
    | { sdks: Record<string, { tautulli?: ExtensionTautulli }> }
    | undefined;
}

let directory: string;

/**
 * Activates a one-file extension whose manifest `requires` is exactly the given
 * object, and returns the `tautulli` capability it was handed.
 */
async function tautulliSdk(
  requires: Record<string, unknown>
): Promise<ExtensionTautulli | undefined> {
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
    `const record = (globalThis.__seerrSdkTautulliTest ??= { sdks: {} });
module.exports.default = async (sdk) => {
  record.sdks[sdk.id] = sdk;
};
`
  );

  const registry = await discoverExtensions({ directory });
  await activateExtensions(registry);

  const sdk = globalThis.__seerrSdkTautulliTest?.sdks.demo;
  assert.ok(sdk, 'expected the demo extension to have been activated');

  return sdk.tautulli;
}

/** The capability, asserted present, for the tests about what it returns. */
async function grantedTautulli(): Promise<ExtensionTautulli> {
  const tautulli = await tautulliSdk({ tautulli: 'read' });
  assert.ok(tautulli, 'expected tautulli: read to grant the capability');
  return tautulli;
}

/** A movie play. Tautulli reports `duration` in **seconds**. */
const movieRecord = (overrides: Record<string, unknown> = {}) => ({
  rating_key: 4021,
  media_type: 'movie',
  title: 'Fight Club',
  full_title: 'Fight Club',
  duration: 8340,
  date: 1_700_000_000,
  user_id: 4242,
  ...overrides,
});

/** An episode play, which carries its series' key in `grandparent_rating_key`. */
const episodeRecord = (overrides: Record<string, unknown> = {}) => ({
  rating_key: 9001,
  grandparent_rating_key: 8000,
  media_type: 'episode',
  title: 'Winter Is Coming',
  full_title: 'Game of Thrones - Winter Is Coming',
  duration: 3600,
  date: 1_700_100_000,
  user_id: 4242,
  ...overrides,
});

let savedTautulli: Record<string, unknown>;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'seerr-ext-tautulli-'));
  globalThis.__seerrSdkTautulliTest = undefined;

  infoResult = { tautulli_version: 'v2.13.4' };
  userStatsResult = { query_days: 0, total_time: 0, total_plays: 0 };
  historyResults = [];
  calls = [];
  tautulliError = undefined;

  savedTautulli = { ...getSettings().tautulli };
  Object.assign(getSettings().tautulli, {
    hostname: 'tautulli.local',
    port: 8181,
    apiKey: 'tautulli-secret',
  });
});

afterEach(async () => {
  globalThis.__seerrSdkTautulliTest = undefined;
  const tautulli = getSettings().tautulli;
  for (const key of Object.keys(tautulli)) {
    delete (tautulli as Record<string, unknown>)[key];
  }
  Object.assign(tautulli, savedTautulli);
  await fs.rm(directory, { recursive: true, force: true });
});

describe('sdk.tautulli gating', () => {
  it('is granted by requires.tautulli: read', async () => {
    const tautulli = await tautulliSdk({ tautulli: 'read' });

    assert.strictEqual(typeof tautulli?.reachable, 'function');
    assert.strictEqual(typeof tautulli?.userTotals, 'function');
    assert.strictEqual(typeof tautulli?.userHistory, 'function');
  });

  it('is absent when the manifest does not declare it', async () => {
    // `settings: 'read'` grants the Tautulli *connection* (hostname and port,
    // key redacted) so an extension can tell the operator which server it is
    // reading. It does not grant the ability to call it — that is this capability,
    // and the manifest has to say so separately.
    const tautulli = await tautulliSdk({ settings: 'read' });

    assert.strictEqual(tautulli, undefined);
  });

  it('is absent when the operator has not configured Tautulli', async () => {
    // The normal state of a fresh install, not an error. An extension has to
    // render "no watch-history source configured", which it can only do if the
    // absence is visible as an absent capability rather than as a call that
    // fails against `undefined:undefined`.
    delete getSettings().tautulli.hostname;

    const tautulli = await tautulliSdk({ tautulli: 'read' });

    assert.strictEqual(tautulli, undefined);
  });
});

describe('sdk.tautulli.reachable', () => {
  it('is true when Tautulli answers', async () => {
    const tautulli = await grantedTautulli();

    assert.strictEqual(await tautulli.reachable(), true);
  });

  it('is false rather than throwing when Tautulli is down', async () => {
    const tautulli = await grantedTautulli();
    tautulliError = new Error('ECONNREFUSED');

    assert.strictEqual(await tautulli.reachable(), false);
  });
});

describe('sdk.tautulli.userTotals', () => {
  it('converts Tautulli seconds into milliseconds', async () => {
    // The conversion this surface exists to do once: Tautulli reports seconds,
    // Tracearr reports milliseconds, and an extension reading both must not have
    // to know which is which.
    userStatsResult = { query_days: 0, total_time: 7200, total_plays: 12 };
    const tautulli = await grantedTautulli();

    assert.deepStrictEqual(await tautulli.userTotals(4242), {
      plays: 12,
      watchTimeMs: 7_200_000,
    });
  });

  it('asks Tautulli about the Plex id it was given', async () => {
    const tautulli = await grantedTautulli();

    await tautulli.userTotals(4242);

    // Core's `getUserWatchStats` takes a `User` and reads `plexId` off it, so the
    // host has to pass something shaped like one. Asserting on it because a
    // regression here is silent: a missing `plexId` makes core throw, which this
    // surface swallows into `null`.
    assert.strictEqual((calls[0].args[0] as { plexId?: number }).plexId, 4242);
  });

  it('resolves null rather than throwing when Tautulli is down', async () => {
    const tautulli = await grantedTautulli();
    tautulliError = new Error('ECONNREFUSED');

    assert.strictEqual(await tautulli.userTotals(4242), null);
  });
});

describe('sdk.tautulli.userHistory', () => {
  it('reports a movie play with its rating key and no series key', async () => {
    historyResults = [movieRecord()];
    const tautulli = await grantedTautulli();

    const [record] = await tautulli.userHistory(4242);

    assert.deepStrictEqual(record, {
      ratingKey: '4021',
      mediaType: 'movie',
      title: 'Fight Club',
      durationMs: 8_340_000,
      watchedAt: new Date(1_700_000_000 * 1000),
      plexUserId: 4242,
    });
  });

  it('carries the series key for an episode', async () => {
    // What makes per-title aggregation possible: Tautulli reports episodes
    // individually, so an extension counting plays of a *series* needs the
    // grandparent key, and core's `media` table is keyed on the series.
    historyResults = [episodeRecord()];
    const tautulli = await grantedTautulli();

    const [record] = await tautulli.userHistory(4242);

    assert.strictEqual(record.ratingKey, '9001');
    assert.strictEqual(record.seriesRatingKey, '8000');
  });

  it('stringifies rating keys, which Tautulli reports as numbers', async () => {
    // `Media.ratingKey` is a varchar, and `findByRatingKey` compares strings, so
    // handing an extension Tautulli's number would make every lookup miss.
    historyResults = [movieRecord()];
    const tautulli = await grantedTautulli();

    const [record] = await tautulli.userHistory(4242);

    assert.strictEqual(typeof record.ratingKey, 'string');
  });

  it('caps how much history it returns', async () => {
    historyResults = Array.from({ length: 40 }, (_unused, index) =>
      movieRecord({ rating_key: 1000 + index })
    );
    const tautulli = await grantedTautulli();

    const records = await tautulli.userHistory(4242, { limit: 5 });

    assert.strictEqual(records.length, 5);
  });

  it('refuses a limit above the host cap', async () => {
    // The cap is the host's rather than the extension's, so an extension cannot
    // put an unbounded Tautulli crawl on a cron.
    historyResults = Array.from({ length: 200 }, (_unused, index) =>
      movieRecord({ rating_key: 1000 + index })
    );
    const tautulli = await grantedTautulli();

    const records = await tautulli.userHistory(4242, { limit: 10_000 });

    assert.strictEqual(records.length, 100);
  });

  it('skips a record with no rating key at all', async () => {
    // Such a record cannot be attributed to a title, and passing it through
    // would make the extension's own aggregate key on `'undefined'`.
    historyResults = [movieRecord({ rating_key: undefined }), movieRecord()];
    const tautulli = await grantedTautulli();

    const records = await tautulli.userHistory(4242);

    assert.strictEqual(records.length, 1);
  });

  it('resolves an empty array rather than throwing when Tautulli is down', async () => {
    const tautulli = await grantedTautulli();
    tautulliError = new Error('ECONNREFUSED');

    assert.deepStrictEqual(await tautulli.userHistory(4242), []);
  });
});
