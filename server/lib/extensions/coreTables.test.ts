import {
  coreExtensionTableNames,
  reservedExtensionId,
} from '@server/lib/extensions/coreTables';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getMetadataArgsStorage } from 'typeorm';

// The entity modules have to be loaded for `getMetadataArgsStorage()` to know
// about them. Importing the barrel rather than the three `Extension*` entities
// keeps this honest: a *new* core table in the `ext_` namespace is registered by
// being imported here, and `covers every core table in the ext_ namespace` then
// fails until it is added to `coreExtensionTableNames`.
import '@server/entity/Blocklist';
import '@server/entity/DiscoverSlider';
import '@server/entity/ExtensionKv';
import '@server/entity/ExtensionNotificationSubscription';
import '@server/entity/ExtensionPermission';
import '@server/entity/Issue';
import '@server/entity/IssueComment';
import '@server/entity/Media';
import '@server/entity/MediaRequest';
import '@server/entity/OverrideRule';
import '@server/entity/Season';
import '@server/entity/SeasonRequest';
import '@server/entity/Session';
import '@server/entity/User';
import '@server/entity/UserPushSubscription';
import '@server/entity/UserSettings';
import '@server/entity/Watchlist';

/**
 * `coreExtensionTableNames` reads table names off the entity decorators, so
 * renaming a table in its entity cannot desync it. What it *cannot* notice is a
 * brand-new core entity added to the `ext_` namespace and not added to its
 * `targets` list — and every prefix protection in `install.ts` and
 * `migrations.ts` is built on that list, so an omission silently stops guarding
 * the new table.
 */
describe('coreExtensionTableNames', () => {
  it('covers every core table in the ext_ namespace', () => {
    const inNamespace = getMetadataArgsStorage()
      .tables.map((table) => table.name)
      .filter((name): name is string => !!name)
      .filter((name) => name.startsWith('ext_'));

    assert.notStrictEqual(
      inNamespace.length,
      0,
      'expected the entity metadata to include the ext_ tables; the imports above are what registers them'
    );

    const covered = coreExtensionTableNames();

    assert.deepStrictEqual(
      [...new Set(inNamespace)].sort(),
      [...covered].sort(),
      'a core table in the ext_ namespace is missing from coreExtensionTableNames, so nothing reserves the extension id that would claim it'
    );
  });

  it('reads the names off the entity decorators', () => {
    assert.deepStrictEqual(coreExtensionTableNames().sort(), [
      'ext_kv',
      'ext_notification_subscription',
      'ext_permission',
    ]);
  });
});

describe('reservedExtensionId', () => {
  it('reserves an id whose table prefix claims a core table', () => {
    // `ext_notification_` is a prefix of `ext_notification_subscription`, so this
    // extension would own — and on uninstall drop — every user's subscriptions.
    assert.strictEqual(
      reservedExtensionId('notification'),
      'ext_notification_subscription'
    );
  });

  it('leaves an id that merely shares a word prefix alone', () => {
    // `ext_notifications_` is not a prefix of `ext_notification_subscription`.
    assert.strictEqual(reservedExtensionId('notifications'), undefined);
  });

  it('does not reserve an exact core table name', () => {
    // `ext_kv_` is not a prefix of `ext_kv`: an id only collides when it claims a
    // core table as something *under* its own prefix. `ext_kv` itself is out of
    // reach because an extension never gets an unsuffixed table.
    assert.strictEqual(reservedExtensionId('kv'), undefined);
  });

  it('leaves an ordinary id free', () => {
    assert.strictEqual(reservedExtensionId('watch-history'), undefined);
  });
});
