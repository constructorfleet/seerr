import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AllSettings } from '@server/lib/settings';
import Settings from '@server/lib/settings';

describe('MainSettings.autoApproveRemovalWhenUnavailable', () => {
  it('defaults to false so that destructive removals stay opt-in', () => {
    const settings = new Settings();

    assert.strictEqual(settings.main.autoApproveRemovalWhenUnavailable, false);
  });

  it('falls back to the default for installs whose settings.json predates the key', () => {
    const jsonWithoutKey = {
      main: { applicationTitle: 'Existing Install' },
    } as AllSettings;

    const settings = new Settings(jsonWithoutKey);

    assert.strictEqual(settings.main.applicationTitle, 'Existing Install');
    assert.strictEqual(settings.main.autoApproveRemovalWhenUnavailable, false);
  });

  it('round-trips an enabled value through the main setter', () => {
    const settings = new Settings();

    settings.main = {
      ...settings.main,
      autoApproveRemovalWhenUnavailable: true,
    };

    assert.strictEqual(settings.main.autoApproveRemovalWhenUnavailable, true);
  });

  it('preserves an enabled value when unrelated main settings are merged', () => {
    const settings = new Settings();
    settings.main = {
      ...settings.main,
      autoApproveRemovalWhenUnavailable: true,
    };

    settings.main = { hideAvailable: true } as typeof settings.main;

    assert.strictEqual(settings.main.hideAvailable, true);
    assert.strictEqual(settings.main.autoApproveRemovalWhenUnavailable, true);
  });

  // The unrequest confirmation modal tells the user whether their removal will
  // be approved automatically, so the client needs this value.
  it('is exposed through the public settings', () => {
    const settings = new Settings();

    assert.strictEqual(
      settings.fullPublicSettings.autoApproveRemovalWhenUnavailable,
      false
    );

    settings.main = {
      ...settings.main,
      autoApproveRemovalWhenUnavailable: true,
    };

    assert.strictEqual(
      settings.fullPublicSettings.autoApproveRemovalWhenUnavailable,
      true
    );
  });
});
