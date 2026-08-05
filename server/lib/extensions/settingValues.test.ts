/**
 * Tests for the declared-setting values an operator edits and an extension reads.
 *
 * Like `settings.test.ts`, every test mocks `getSettings().save` out and restores
 * the `extensions` record: the singleton is process-wide and its `save()` writes
 * the developer's real `config/settings.json`.
 *
 * Declarations are injected rather than taken from a live registry, so a test
 * states the manifest it is testing against in the test itself.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { ExtensionManifestSetting } from '@server/lib/extensions/manifest';
import {
  REDACTED_SECRET,
  clearExtensionSettingValue,
  clearExtensionSettingValues,
  getExtensionSettingValues,
  getRedactedExtensionSettingValues,
  setExtensionSettingDeclarations,
  updateExtensionSettingValues,
} from '@server/lib/extensions/settingValues';
import { getSettings } from '@server/lib/settings';

const declarations: ExtensionManifestSetting[] = [
  { key: 'enabled', type: 'boolean', name: 'Enabled', default: true },
  { key: 'endpoint', type: 'string', name: 'Endpoint' },
  {
    key: 'batch_size',
    type: 'number',
    name: 'Batch Size',
    default: 25,
    min: 1,
    max: 100,
  },
  {
    key: 'mode',
    type: 'select',
    name: 'Mode',
    default: 'plex',
    options: [
      { value: 'plex', label: 'Plex' },
      { value: 'jellyfin', label: 'Jellyfin' },
    ],
  },
  { key: 'api_token', type: 'secret', name: 'API Token' },
];

let save: ReturnType<
  typeof mock.method<ReturnType<typeof getSettings>, 'save'>
>;

beforeEach(() => {
  getSettings().extensions = {};
  save = mock.method(getSettings(), 'save', async () => undefined);
  setExtensionSettingDeclarations((id) => (id === 'demo' ? declarations : []));
});

afterEach(() => {
  mock.restoreAll();
  getSettings().extensions = {};
  setExtensionSettingDeclarations(() => []);
});

describe('getExtensionSettingValues', () => {
  it('applies the declared default for a key never saved', () => {
    assert.deepStrictEqual(getExtensionSettingValues('demo'), {
      enabled: true,
      batch_size: 25,
      mode: 'plex',
    });
  });

  it('omits a key with no declared default rather than reporting undefined', () => {
    // `'endpoint' in values` is the question an extension asks to tell "the
    // operator left it blank" from "the operator saved an empty string".
    assert.strictEqual('endpoint' in getExtensionSettingValues('demo'), false);
  });

  it('prefers a saved value over the declared default', async () => {
    await updateExtensionSettingValues('demo', { batch_size: 5 });

    assert.strictEqual(getExtensionSettingValues('demo').batch_size, 5);
  });

  it('reports a saved secret in full', async () => {
    await updateExtensionSettingValues('demo', { api_token: 'hunter2' });

    // The extension is trusted, in-process code that needs the real credential
    // to use it. Redaction is for the browser.
    assert.strictEqual(getExtensionSettingValues('demo').api_token, 'hunter2');
  });

  it('ignores a stored value whose key the manifest no longer declares', async () => {
    await updateExtensionSettingValues('demo', { batch_size: 5 });
    setExtensionSettingDeclarations(() => [declarations[0]]);

    assert.deepStrictEqual(getExtensionSettingValues('demo'), {
      enabled: true,
    });
  });

  it('ignores a stored value that no longer typechecks against its declaration', async () => {
    // An upgrade can change a key's type. The stored value is left on disk in
    // case the operator downgrades, but a `string` handed to an extension that
    // now expects a `number` would be a `TypeError` inside the extension.
    getSettings().extensions.demo = {
      enabled: true,
      values: { batch_size: 'twenty' },
    };

    assert.strictEqual(getExtensionSettingValues('demo').batch_size, 25);
  });

  it('is empty for an extension that declares no settings', () => {
    assert.deepStrictEqual(getExtensionSettingValues('other'), {});
  });
});

describe('getRedactedExtensionSettingValues', () => {
  it('reports a set secret as the sentinel, never the value', async () => {
    await updateExtensionSettingValues('demo', { api_token: 'hunter2' });

    const values = getRedactedExtensionSettingValues('demo');

    assert.strictEqual(values.api_token, REDACTED_SECRET);
    assert.strictEqual(
      JSON.stringify(values).includes('hunter2'),
      false,
      'the secret must not reach the client in any field'
    );
  });

  it('omits an unset secret, so the form can tell set from unset', () => {
    assert.strictEqual(
      'api_token' in getRedactedExtensionSettingValues('demo'),
      false
    );
  });

  it('leaves every non-secret value alone', async () => {
    await updateExtensionSettingValues('demo', {
      endpoint: 'https://plex.tv',
      api_token: 'hunter2',
    });

    assert.deepStrictEqual(getRedactedExtensionSettingValues('demo'), {
      enabled: true,
      endpoint: 'https://plex.tv',
      batch_size: 25,
      mode: 'plex',
      api_token: REDACTED_SECRET,
    });
  });
});

describe('updateExtensionSettingValues', () => {
  it('persists only the keys it was given', async () => {
    await updateExtensionSettingValues('demo', { endpoint: 'https://plex.tv' });
    await updateExtensionSettingValues('demo', { batch_size: 5 });

    assert.deepStrictEqual(getSettings().extensions.demo?.values, {
      endpoint: 'https://plex.tv',
      batch_size: 5,
    });
  });

  it('does not disturb the enable state', async () => {
    getSettings().extensions.demo = { enabled: false };

    await updateExtensionSettingValues('demo', { batch_size: 5 });

    assert.strictEqual(getSettings().extensions.demo?.enabled, false);
  });

  it('writes the settings file once per update', async () => {
    await updateExtensionSettingValues('demo', { batch_size: 5, mode: 'plex' });

    assert.strictEqual(save.mock.callCount(), 1);
  });

  it('refuses an undeclared key', async () => {
    await assert.rejects(
      () => updateExtensionSettingValues('demo', { batch_sze: 5 }),
      /"batch_sze"/
    );
  });

  it('refuses every key of an extension that declares no settings', async () => {
    await assert.rejects(
      () => updateExtensionSettingValues('other', { enabled: true }),
      /"enabled"/
    );
  });

  it('refuses a value of the wrong type', async () => {
    for (const update of [
      { enabled: 'yes' },
      { batch_size: 'many' },
      { endpoint: 42 },
      { mode: false },
    ]) {
      await assert.rejects(
        () => updateExtensionSettingValues('demo', update as never),
        /is not a/
      );
    }
  });

  it('refuses a select value that is not one of its options', async () => {
    await assert.rejects(
      () => updateExtensionSettingValues('demo', { mode: 'emby' }),
      /not one of/
    );
  });

  it('refuses a number outside its declared bounds', async () => {
    await assert.rejects(
      () => updateExtensionSettingValues('demo', { batch_size: 0 }),
      /below the minimum/
    );
    await assert.rejects(
      () => updateExtensionSettingValues('demo', { batch_size: 101 }),
      /above the maximum/
    );
  });

  it('persists nothing when any key in the update is invalid', async () => {
    await assert.rejects(() =>
      updateExtensionSettingValues('demo', {
        endpoint: 'https://plex.tv',
        batch_size: 'many',
      } as never)
    );

    // Validated as a whole before anything is written, so a form submission is
    // all-or-nothing rather than half-applied.
    assert.strictEqual(getSettings().extensions.demo, undefined);
  });

  it('leaves a secret unchanged when given the redaction sentinel', async () => {
    await updateExtensionSettingValues('demo', { api_token: 'hunter2' });

    // The client renders a set secret as the sentinel, so it submits the sentinel
    // back on every save of the form. Treating that as a new value would wipe the
    // credential the first time the operator changed anything else.
    await updateExtensionSettingValues('demo', {
      api_token: REDACTED_SECRET,
      batch_size: 5,
    });

    assert.strictEqual(getExtensionSettingValues('demo').api_token, 'hunter2');
    assert.strictEqual(getExtensionSettingValues('demo').batch_size, 5);
  });

  it('leaves a secret unchanged when given an empty string', async () => {
    await updateExtensionSettingValues('demo', { api_token: 'hunter2' });

    // An empty field in the form means "I did not type a new one", not "clear it".
    await updateExtensionSettingValues('demo', { api_token: '' });

    assert.strictEqual(getExtensionSettingValues('demo').api_token, 'hunter2');
  });

  it('accepts a replacement secret', async () => {
    await updateExtensionSettingValues('demo', { api_token: 'hunter2' });
    await updateExtensionSettingValues('demo', { api_token: 'hunter3' });

    assert.strictEqual(getExtensionSettingValues('demo').api_token, 'hunter3');
  });

  it('does not write the settings file when a secret update is a no-op', async () => {
    await updateExtensionSettingValues('demo', { api_token: 'hunter2' });
    const before = save.mock.callCount();

    await updateExtensionSettingValues('demo', { api_token: REDACTED_SECRET });

    assert.strictEqual(save.mock.callCount(), before);
  });

  it('accepts an empty string for a non-secret string', async () => {
    await updateExtensionSettingValues('demo', { endpoint: '' });

    assert.strictEqual(getExtensionSettingValues('demo').endpoint, '');
  });
});

describe('clearExtensionSettingValue', () => {
  it('clears a secret, which submitting the sentinel cannot do', async () => {
    await updateExtensionSettingValues('demo', { api_token: 'hunter2' });

    await clearExtensionSettingValue('demo', 'api_token');

    assert.strictEqual('api_token' in getExtensionSettingValues('demo'), false);
  });

  it('restores the declared default when clearing a key that has one', async () => {
    await updateExtensionSettingValues('demo', { batch_size: 5 });

    await clearExtensionSettingValue('demo', 'batch_size');

    assert.strictEqual(getExtensionSettingValues('demo').batch_size, 25);
  });

  it('refuses an undeclared key', async () => {
    await assert.rejects(
      () => clearExtensionSettingValue('demo', 'batch_sze'),
      /"batch_sze"/
    );
  });

  it('clearing a key that was never saved is not an error', async () => {
    await clearExtensionSettingValue('demo', 'endpoint');

    assert.strictEqual(getSettings().extensions.demo?.values, undefined);
  });
});

describe('clearExtensionSettingValues', () => {
  it('drops every value on uninstall', async () => {
    await updateExtensionSettingValues('demo', {
      endpoint: 'https://plex.tv',
      api_token: 'hunter2',
    });

    await clearExtensionSettingValues('demo');

    assert.strictEqual(getSettings().extensions.demo?.values, undefined);
  });

  it('leaves the enable state alone, which uninstall forgets separately', async () => {
    getSettings().extensions.demo = {
      enabled: false,
      values: { mode: 'plex' },
    };

    await clearExtensionSettingValues('demo');

    assert.deepStrictEqual(getSettings().extensions.demo, { enabled: false });
  });

  it('does not write when there was nothing to clear', async () => {
    await clearExtensionSettingValues('demo');

    assert.strictEqual(save.mock.callCount(), 0);
  });
});
