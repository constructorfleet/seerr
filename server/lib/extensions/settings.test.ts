/**
 * Tests for the persisted enable/disable state, which is what
 * `DiscoverExtensionsOptions.isEnabled` reads at boot.
 *
 * `getSettings()` is a process-wide singleton whose `save()` writes
 * `config/settings.json`, so every test here mocks `save` out and restores the
 * `extensions` record afterwards. Leaving either in place would leak into the
 * other suites that read core settings.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import {
  disableExtension,
  enableExtension,
  extensionEnabledResolver,
  extensionSettings,
  forgetExtensionSettings,
  isExtensionEnabled,
  loadExtensionEnabledResolver,
} from '@server/lib/extensions/settings';
import { SETTINGS_PATH, getSettings } from '@server/lib/settings';
import fs from 'fs/promises';
import path from 'path';

let save: ReturnType<
  typeof mock.method<ReturnType<typeof getSettings>, 'save'>
>;

beforeEach(() => {
  getSettings().extensions = {};
  save = mock.method(getSettings(), 'save', async () => undefined);
});

afterEach(() => {
  mock.restoreAll();
  getSettings().extensions = {};
});

describe('extension enable state', () => {
  it('treats an unknown extension as enabled', () => {
    // Installing is an explicit admin action, so the default for something
    // present on disk with nothing recorded about it is "on". It also means an
    // upgrade from a Seerr that had no such setting keeps loading what it loaded.
    assert.strictEqual(isExtensionEnabled('demo'), true);
  });

  it('persists a disable', async () => {
    await disableExtension('demo');

    assert.strictEqual(isExtensionEnabled('demo'), false);
    assert.deepStrictEqual(getSettings().extensions.demo, { enabled: false });
  });

  it('persists an enable', async () => {
    await disableExtension('demo');
    await enableExtension('demo');

    assert.strictEqual(isExtensionEnabled('demo'), true);
    assert.deepStrictEqual(getSettings().extensions.demo, { enabled: true });
  });

  it('writes the settings file once per change', async () => {
    await disableExtension('demo');

    assert.strictEqual(save.mock.callCount(), 1);
  });

  it('does not affect other extensions', async () => {
    await disableExtension('demo');

    assert.strictEqual(isExtensionEnabled('other'), true);
  });

  it('forgets an extension entirely', async () => {
    await disableExtension('demo');
    await forgetExtensionSettings('demo');

    assert.strictEqual('demo' in getSettings().extensions, false);
    // And so a reinstall of something that was disabled comes back on, rather
    // than installing successfully and then silently not loading.
    assert.strictEqual(isExtensionEnabled('demo'), true);
  });

  it('forgetting an extension that has no setting is not an error', async () => {
    await forgetExtensionSettings('absent');

    assert.deepStrictEqual(getSettings().extensions, {});
  });

  it('reports every recorded setting', async () => {
    await disableExtension('demo');
    await enableExtension('other');

    assert.deepStrictEqual(extensionSettings(), {
      demo: { enabled: false },
      other: { enabled: true },
    });
  });
});

describe('extensionEnabledResolver', () => {
  it('has the shape discoverExtensions expects', () => {
    const isEnabled = extensionEnabledResolver();

    assert.strictEqual(isEnabled('demo'), true);
  });

  it('reflects a persisted disable', async () => {
    const isEnabled = extensionEnabledResolver();

    await disableExtension('demo');

    // Read per call rather than captured, so a disable made through the API takes
    // effect on the next boot without anything having to re-create the resolver.
    assert.strictEqual(isEnabled('demo'), false);
  });
});

/**
 * Boot's resolver reads `settings.json` directly, because discovery runs before
 * `getSettings().load()`. These tests write that file and restore it, since it is
 * the developer's real config in a working checkout.
 */
describe('loadExtensionEnabledResolver', () => {
  let original: string | undefined;

  beforeEach(async () => {
    original = await fs.readFile(SETTINGS_PATH, 'utf-8').catch(() => undefined);
  });

  afterEach(async () => {
    if (original === undefined) {
      await fs.rm(SETTINGS_PATH, { force: true });
    } else {
      await fs.writeFile(SETTINGS_PATH, original);
    }
  });

  async function writeSettings(data: unknown): Promise<void> {
    await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
    await fs.writeFile(SETTINGS_PATH, JSON.stringify(data));
  }

  it('reads a disable from the settings file, not the unloaded singleton', async () => {
    await writeSettings({ extensions: { demo: { enabled: false } } });

    const isEnabled = await loadExtensionEnabledResolver();

    assert.strictEqual(isEnabled('demo'), false);
    assert.strictEqual(isEnabled('other'), true);
  });

  it('enables everything when the settings file has no extensions key', async () => {
    await writeSettings({ main: {} });

    const isEnabled = await loadExtensionEnabledResolver();

    assert.strictEqual(isEnabled('demo'), true);
  });

  it('enables everything when there is no settings file', async () => {
    await fs.rm(SETTINGS_PATH, { force: true });

    const isEnabled = await loadExtensionEnabledResolver();

    assert.strictEqual(isEnabled('demo'), true);
  });

  it('enables everything when the settings file is corrupt', async () => {
    // A settings file Seerr cannot parse is a problem, but it is not this
    // module's problem to be fatal about: `load()` reports it moments later.
    await fs.writeFile(SETTINGS_PATH, '{ "extensions": ');

    const isEnabled = await loadExtensionEnabledResolver();

    assert.strictEqual(isEnabled('demo'), true);
  });

  it('does not create a settings file as a side effect', async () => {
    await fs.rm(SETTINGS_PATH, { force: true });

    await loadExtensionEnabledResolver();

    // `Settings.load` generates missing keys and writes them back; reading this
    // early must not pre-empt the real load that happens moments later.
    await assert.rejects(() => fs.access(SETTINGS_PATH));
  });
});
