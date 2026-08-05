import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { getRepository } from '@server/datasource';
import { ExtensionPermission } from '@server/entity/ExtensionPermission';
import { User } from '@server/entity/User';
import type { ExtensionManifest } from '@server/lib/extensions/manifest';
import type { ExtensionPermissionDeclaration } from '@server/lib/extensions/permissions';
import {
  buildExtensionPermission,
  clearExtensionPermissionDefaults,
  declarationsFromRegistry,
  getEffectiveExtensionPermissions,
  getExtensionPermissionDefault,
  getExtensionPermissionMatrix,
  getExtensionPermissions,
  grantExtensionPermission,
  hasExtensionPermission,
  isExtensionPermission,
  parseExtensionPermission,
  revokeExtensionPermission,
  setExtensionPermissionDeclarations,
  setExtensionPermissionDefault,
  setExtensionPermissionHolders,
} from '@server/lib/extensions/permissions';
import { ExtensionRegistry } from '@server/lib/extensions/registry';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { isExtensionAuthenticated } from '@server/middleware/extensionAuth';
import userRoutes from '@server/routes/user';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import request from 'supertest';

setupTestDb();

/**
 * The declarations a `watch-history` manifest would contribute: one plain
 * permission, one gated on a core `Permission`, one granted to new users.
 */
const declarations: ExtensionPermissionDeclaration[] = [
  {
    permission: 'watch-history:view_own',
    extensionId: 'watch-history',
    key: 'view_own',
    name: 'View Own History',
    default: true,
    requiresCore: [],
  },
  {
    permission: 'watch-history:view_all',
    extensionId: 'watch-history',
    key: 'view_all',
    name: 'View All History',
    default: false,
    requiresCore: [Permission.MANAGE_USERS],
  },
  {
    permission: 'unrequest:remove_own',
    extensionId: 'unrequest',
    key: 'remove_own',
    name: 'Remove Own Requests',
    default: false,
    requiresCore: [Permission.REQUEST],
  },
];

/** Declares `declarations` for the duration of one test. */
function declare(only: ExtensionPermissionDeclaration[] = declarations): void {
  setExtensionPermissionDeclarations(() => only);
}

afterEach(() => {
  setExtensionPermissionDeclarations(() => []);
});

function getUser(email: string): Promise<User> {
  return getRepository(User).findOneOrFail({ where: { email } });
}

describe('extension permission namespacing', () => {
  it('namespaces a manifest key under its extension id', () => {
    assert.strictEqual(
      buildExtensionPermission('watch-history', 'view_own'),
      'watch-history:view_own'
    );
  });

  it('round-trips a namespaced permission', () => {
    const permission = buildExtensionPermission('watch-history', 'view_own');

    assert.deepStrictEqual(parseExtensionPermission(permission), {
      extensionId: 'watch-history',
      key: 'view_own',
    });
  });

  it('refuses to build a permission for an invalid extension id', () => {
    assert.throws(() => buildExtensionPermission('Watch_History', 'view_own'));
  });

  it('refuses to build a permission for an invalid key', () => {
    assert.throws(() => buildExtensionPermission('watch-history', 'View Own'));
  });

  it('does not parse a string without a separator', () => {
    assert.strictEqual(parseExtensionPermission('view_own'), undefined);
  });

  it('does not parse a string with an invalid extension id', () => {
    assert.strictEqual(
      parseExtensionPermission('watch_history:view_own'),
      undefined
    );
  });

  it('does not parse a string with an invalid key', () => {
    assert.strictEqual(
      parseExtensionPermission('watch-history:view own'),
      undefined
    );
  });

  it('does not parse a string with more than one separator', () => {
    assert.strictEqual(
      parseExtensionPermission('watch-history:view_own:extra'),
      undefined
    );
  });

  it('recognizes a namespaced permission but not a core permission name', () => {
    assert.strictEqual(isExtensionPermission('watch-history:view_own'), true);
    assert.strictEqual(isExtensionPermission('MANAGE_USERS'), false);
  });
});

describe('extension permission declarations', () => {
  it('collects namespaced declarations from an active extension', () => {
    const registry = new ExtensionRegistry();
    registry.add({
      id: 'watch-history',
      directory: '/tmp/watch-history',
      status: 'active',
      entities: [],
      migrations: [],
      manifest: {
        id: 'watch-history',
        name: 'Watch History',
        version: '1.0.0',
        apiVersion: '^1.0.0',
        server: 'dist/server.js',
        provides: {
          permissions: [
            { key: 'view_own', name: 'View Own History', default: true },
            {
              key: 'view_all',
              name: 'View All History',
              requiresCore: ['MANAGE_USERS'],
            },
          ],
        },
      } as ExtensionManifest,
    });

    assert.deepStrictEqual(declarationsFromRegistry(registry), [
      {
        permission: 'watch-history:view_own',
        extensionId: 'watch-history',
        key: 'view_own',
        name: 'View Own History',
        default: true,
        requiresCore: [],
      },
      {
        permission: 'watch-history:view_all',
        extensionId: 'watch-history',
        key: 'view_all',
        name: 'View All History',
        default: false,
        requiresCore: [Permission.MANAGE_USERS],
      },
    ]);
  });

  it('ignores a quarantined extension', () => {
    const registry = new ExtensionRegistry();
    registry.add({
      id: 'watch-history',
      directory: '/tmp/watch-history',
      status: 'failed',
      entities: [],
      migrations: [],
      manifest: {
        id: 'watch-history',
        name: 'Watch History',
        version: '1.0.0',
        apiVersion: '^1.0.0',
        server: 'dist/server.js',
        provides: {
          permissions: [{ key: 'view_own', name: 'View Own History' }],
        },
      } as ExtensionManifest,
    });

    assert.deepStrictEqual(declarationsFromRegistry(registry), []);
  });
});

describe('hasExtensionPermission', () => {
  it('detects a granted permission', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    await grantExtensionPermission(friend.id, 'watch-history:view_own');

    assert.strictEqual(
      await hasExtensionPermission(friend.id, 'watch-history:view_own'),
      true
    );
  });

  it('denies a permission that was never granted', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    assert.strictEqual(
      await hasExtensionPermission(friend.id, 'watch-history:view_own'),
      false
    );
  });

  it('does not let one user borrow another user grant', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    const other = await getRepository(User).save(
      new User({ email: 'stranger@seerr.dev', avatar: '', permissions: 32 })
    );

    await grantExtensionPermission(other.id, 'watch-history:view_own');

    assert.strictEqual(
      await hasExtensionPermission(friend.id, 'watch-history:view_own'),
      false
    );
  });

  it('grants an admin an extension permission with no row present', async () => {
    declare();
    const admin = await getUser('admin@seerr.dev');

    assert.strictEqual(
      await hasExtensionPermission(admin.id, 'watch-history:view_own'),
      true
    );
    assert.strictEqual(
      await getRepository(ExtensionPermission).countBy({ userId: admin.id }),
      0
    );
  });

  it('grants an admin a permission no extension declares', async () => {
    declare();
    const admin = await getUser('admin@seerr.dev');

    assert.strictEqual(
      await hasExtensionPermission(admin.id, 'nothing:at_all'),
      true
    );
  });

  it('denies a user that does not exist', async () => {
    declare();

    assert.strictEqual(
      await hasExtensionPermission(9999, 'watch-history:view_own'),
      false
    );
  });

  it('namespaces a bare key against the calling extension', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    await grantExtensionPermission(friend.id, 'watch-history:view_own');

    assert.strictEqual(
      await hasExtensionPermission(friend.id, 'view_own', {
        extensionId: 'watch-history',
      }),
      true
    );
    assert.strictEqual(
      await hasExtensionPermission(friend.id, 'view_own', {
        extensionId: 'unrequest',
      }),
      false
    );
  });

  it('resolves a core Permission passed as a number', async () => {
    const friend = await getUser('friend@seerr.dev');

    assert.strictEqual(
      await hasExtensionPermission(friend.id, Permission.REQUEST),
      true
    );
    assert.strictEqual(
      await hasExtensionPermission(friend.id, Permission.MANAGE_USERS),
      false
    );
  });

  it('resolves a core Permission passed by name', async () => {
    const friend = await getUser('friend@seerr.dev');

    assert.strictEqual(
      await hasExtensionPermission(friend.id, 'REQUEST'),
      true
    );
    assert.strictEqual(
      await hasExtensionPermission(friend.id, 'MANAGE_USERS'),
      false
    );
  });

  it('requires every permission when several are asked for', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    await grantExtensionPermission(friend.id, 'watch-history:view_own');

    assert.strictEqual(
      await hasExtensionPermission(friend.id, [
        'watch-history:view_own',
        Permission.REQUEST,
      ]),
      true
    );
    assert.strictEqual(
      await hasExtensionPermission(friend.id, [
        'watch-history:view_own',
        Permission.MANAGE_USERS,
      ]),
      false
    );
  });

  it('requires only one permission when asked with type or', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    assert.strictEqual(
      await hasExtensionPermission(
        friend.id,
        ['watch-history:view_own', Permission.REQUEST],
        { type: 'or' }
      ),
      true
    );
  });

  it('grants when nothing is required', async () => {
    const friend = await getUser('friend@seerr.dev');

    assert.strictEqual(await hasExtensionPermission(friend.id, []), true);
  });
});

describe('requiresCore', () => {
  it('denies a granted permission when the core permission is missing', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    await grantExtensionPermission(friend.id, 'watch-history:view_all');

    assert.strictEqual(
      await hasExtensionPermission(friend.id, 'watch-history:view_all'),
      false
    );
  });

  it('allows a granted permission once the core permission is held', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    await grantExtensionPermission(friend.id, 'watch-history:view_all');
    friend.permissions = Permission.REQUEST | Permission.MANAGE_USERS;
    await getRepository(User).save(friend);

    assert.strictEqual(
      await hasExtensionPermission(friend.id, 'watch-history:view_all'),
      true
    );
  });

  it('still stores the grant when the core permission is missing', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    await grantExtensionPermission(friend.id, 'watch-history:view_all');

    assert.deepStrictEqual(await getExtensionPermissions(friend.id), [
      'watch-history:view_all',
    ]);
  });

  it('requires every named core permission', async () => {
    setExtensionPermissionDeclarations(() => [
      {
        permission: 'demo:both',
        extensionId: 'demo',
        key: 'both',
        name: 'Both',
        default: false,
        requiresCore: [Permission.REQUEST, Permission.VOTE],
      },
    ]);
    const friend = await getUser('friend@seerr.dev');

    await grantExtensionPermission(friend.id, 'demo:both');

    assert.strictEqual(
      await hasExtensionPermission(friend.id, 'demo:both'),
      false
    );

    friend.permissions = Permission.REQUEST | Permission.VOTE;
    await getRepository(User).save(friend);

    assert.strictEqual(
      await hasExtensionPermission(friend.id, 'demo:both'),
      true
    );
  });

  it('does not apply to an admin', async () => {
    declare();
    const admin = await getUser('admin@seerr.dev');

    assert.strictEqual(
      await hasExtensionPermission(admin.id, 'watch-history:view_all'),
      true
    );
  });

  it('ignores requiresCore for a permission no installed extension declares', async () => {
    const friend = await getUser('friend@seerr.dev');

    await grantExtensionPermission(friend.id, 'watch-history:view_all');

    assert.strictEqual(
      await hasExtensionPermission(friend.id, 'watch-history:view_all'),
      true
    );
  });
});

describe('grant and revoke', () => {
  it('is idempotent when the same permission is granted twice', async () => {
    const friend = await getUser('friend@seerr.dev');

    await grantExtensionPermission(friend.id, 'watch-history:view_own');
    await grantExtensionPermission(friend.id, 'watch-history:view_own');

    assert.strictEqual(
      await getRepository(ExtensionPermission).countBy({ userId: friend.id }),
      1
    );
  });

  it('grants several permissions at once', async () => {
    const friend = await getUser('friend@seerr.dev');

    await grantExtensionPermission(friend.id, [
      'watch-history:view_own',
      'unrequest:remove_own',
    ]);

    assert.deepStrictEqual(await getExtensionPermissions(friend.id), [
      'unrequest:remove_own',
      'watch-history:view_own',
    ]);
  });

  it('revokes a granted permission', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    await grantExtensionPermission(friend.id, 'watch-history:view_own');
    await revokeExtensionPermission(friend.id, 'watch-history:view_own');

    assert.strictEqual(
      await hasExtensionPermission(friend.id, 'watch-history:view_own'),
      false
    );
    assert.deepStrictEqual(await getExtensionPermissions(friend.id), []);
  });

  it('leaves other permissions in place when one is revoked', async () => {
    const friend = await getUser('friend@seerr.dev');

    await grantExtensionPermission(friend.id, [
      'watch-history:view_own',
      'unrequest:remove_own',
    ]);
    await revokeExtensionPermission(friend.id, 'watch-history:view_own');

    assert.deepStrictEqual(await getExtensionPermissions(friend.id), [
      'unrequest:remove_own',
    ]);
  });

  it('revoking a permission the user does not hold is a no-op', async () => {
    const friend = await getUser('friend@seerr.dev');

    await revokeExtensionPermission(friend.id, 'watch-history:view_own');

    assert.deepStrictEqual(await getExtensionPermissions(friend.id), []);
  });

  it('refuses to store a permission that is not namespaced', async () => {
    const friend = await getUser('friend@seerr.dev');

    await assert.rejects(() =>
      grantExtensionPermission(friend.id, 'view_own' as never)
    );
    assert.strictEqual(
      await getRepository(ExtensionPermission).countBy({ userId: friend.id }),
      0
    );
  });
});

describe('getExtensionPermissions', () => {
  it('returns an empty list for a user with no grants', async () => {
    const friend = await getUser('friend@seerr.dev');

    assert.deepStrictEqual(await getExtensionPermissions(friend.id), []);
  });

  it('reports only the granted rows, without the admin short-circuit', async () => {
    declare();
    const admin = await getUser('admin@seerr.dev');

    assert.deepStrictEqual(await getExtensionPermissions(admin.id), []);
  });
});

describe('getEffectiveExtensionPermissions', () => {
  it('resolves every declared permission for an admin', async () => {
    declare();
    const admin = await getUser('admin@seerr.dev');

    assert.deepStrictEqual(await getEffectiveExtensionPermissions(admin.id), [
      'unrequest:remove_own',
      'watch-history:view_all',
      'watch-history:view_own',
    ]);
  });

  it('drops a grant whose requiresCore is unmet', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    await grantExtensionPermission(friend.id, [
      'watch-history:view_own',
      'watch-history:view_all',
      'unrequest:remove_own',
    ]);

    assert.deepStrictEqual(await getEffectiveExtensionPermissions(friend.id), [
      'unrequest:remove_own',
      'watch-history:view_own',
    ]);
  });

  it('is empty for a user that does not exist', async () => {
    declare();

    assert.deepStrictEqual(await getEffectiveExtensionPermissions(9999), []);
  });
});

describe('default permissions', () => {
  it('grants a default permission to a newly created user', async () => {
    declare();

    const user = await getRepository(User).save(
      new User({ email: 'newcomer@seerr.dev', avatar: '', permissions: 32 })
    );

    assert.deepStrictEqual(await getExtensionPermissions(user.id), [
      'watch-history:view_own',
    ]);
  });

  it('does not grant a permission that is not a default', async () => {
    declare();

    const user = await getRepository(User).save(
      new User({ email: 'newcomer@seerr.dev', avatar: '', permissions: 32 })
    );

    assert.strictEqual(
      await hasExtensionPermission(user.id, 'watch-history:view_all'),
      false
    );
  });

  it('grants nothing when no extension declares a default', async () => {
    setExtensionPermissionDeclarations(() => []);

    const user = await getRepository(User).save(
      new User({ email: 'newcomer@seerr.dev', avatar: '', permissions: 32 })
    );

    assert.deepStrictEqual(await getExtensionPermissions(user.id), []);
  });

  it('leaves an existing user untouched', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    friend.username = 'renamed';
    await getRepository(User).save(friend);

    assert.deepStrictEqual(await getExtensionPermissions(friend.id), []);
  });
});

describe('getExtensionPermissionMatrix', () => {
  it('reports the holders of each declared permission', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    await grantExtensionPermission(friend.id, 'watch-history:view_own');

    const matrix = await getExtensionPermissionMatrix('watch-history');

    assert.deepStrictEqual(
      matrix.permissions.map((entry) => entry.permission),
      ['watch-history:view_own', 'watch-history:view_all']
    );

    // The admin is a candidate for every permission, so it appears alongside
    // the actual grant holder — flagged as effective-by-admin, not granted.
    const admin = await getUser('admin@seerr.dev');
    const viewOwn = matrix.permissions[0];

    assert.deepStrictEqual(
      viewOwn.holders.map((holder) => [
        holder.id,
        holder.displayName,
        holder.granted,
        holder.effective,
        holder.effectiveByAdmin,
      ]),
      [
        [admin.id, admin.displayName, false, true, true],
        [friend.id, friend.displayName, true, true, false],
      ]
    );
  });

  it('reports an admin as effective by admin rather than granted', async () => {
    declare();
    const admin = await getUser('admin@seerr.dev');

    const matrix = await getExtensionPermissionMatrix('watch-history');
    const holders = matrix.permissions[0].holders;

    // The ADMIN short-circuit in `hasPermission` is not a row, so offering a
    // revoke for it would be a button that cannot do anything.
    assert.deepStrictEqual(
      holders.map((holder) => [
        holder.id,
        holder.granted,
        holder.effective,
        holder.effectiveByAdmin,
      ]),
      [[admin.id, false, true, true]]
    );
  });

  it('reports a grant with an unmet requiresCore as granted but not effective', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    await grantExtensionPermission(friend.id, 'watch-history:view_all');

    const matrix = await getExtensionPermissionMatrix('watch-history');
    const viewAll = matrix.permissions.find(
      (entry) => entry.permission === 'watch-history:view_all'
    );

    assert.ok(viewAll);
    assert.deepStrictEqual(viewAll.requiresCore, ['MANAGE_USERS']);

    const holder = viewAll.holders.find((entry) => entry.id === friend.id);
    assert.ok(holder);
    assert.strictEqual(holder.granted, true);
    assert.strictEqual(holder.effective, false);
    assert.deepStrictEqual(holder.missingCore, ['MANAGE_USERS']);
  });

  it('reports no permissions for an extension that declares none', async () => {
    declare();

    assert.deepStrictEqual(await getExtensionPermissionMatrix('nothing'), {
      extensionId: 'nothing',
      permissions: [],
      total: 0,
      take: 50,
      skip: 0,
    });
  });

  it('reports no permissions for a disabled extension', async () => {
    // A disabled extension contributes no declarations, so the matrix has
    // nothing to render even though the rows are still on disk.
    const friend = await getUser('friend@seerr.dev');
    await grantExtensionPermission(friend.id, 'watch-history:view_own');
    setExtensionPermissionDeclarations(() => []);

    const matrix = await getExtensionPermissionMatrix('watch-history');

    assert.deepStrictEqual(matrix.permissions, []);
    assert.deepStrictEqual(await getExtensionPermissions(friend.id), [
      'watch-history:view_own',
    ]);
  });

  it('reports the operator default alongside the manifest default', async () => {
    declare();

    let matrix = await getExtensionPermissionMatrix('watch-history');
    assert.strictEqual(matrix.permissions[0].manifestDefault, true);
    assert.strictEqual(matrix.permissions[0].default, true);
    assert.strictEqual(matrix.permissions[0].operatorDefault, undefined);

    await setExtensionPermissionDefault('watch-history', 'view_own', false);

    matrix = await getExtensionPermissionMatrix('watch-history');
    assert.strictEqual(matrix.permissions[0].manifestDefault, true);
    assert.strictEqual(matrix.permissions[0].default, false);
    assert.strictEqual(matrix.permissions[0].operatorDefault, false);
  });

  it('pages the holder list', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    const other = await getRepository(User).save(
      new User({ email: 'stranger@seerr.dev', avatar: '', permissions: 32 })
    );

    await grantExtensionPermission(friend.id, 'watch-history:view_own');
    await grantExtensionPermission(other.id, 'watch-history:view_own');

    // Candidates are the admin plus the two grant holders, ordered by id.
    const page = await getExtensionPermissionMatrix('watch-history', {
      take: 1,
      skip: 2,
    });

    assert.strictEqual(page.total, 3);
    assert.strictEqual(page.permissions[0].holders.length, 1);
    assert.strictEqual(page.permissions[0].holders[0].id, other.id);
  });
});

describe('setExtensionPermissionHolders', () => {
  it('grants a permission to several users at once', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    const other = await getRepository(User).save(
      new User({ email: 'stranger@seerr.dev', avatar: '', permissions: 32 })
    );

    await setExtensionPermissionHolders(
      'watch-history',
      'view_own',
      [friend.id, other.id],
      true
    );

    assert.deepStrictEqual(await getExtensionPermissions(friend.id), [
      'watch-history:view_own',
    ]);
    assert.deepStrictEqual(await getExtensionPermissions(other.id), [
      'watch-history:view_own',
    ]);
  });

  it('is idempotent when granting what is already granted', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    await setExtensionPermissionHolders(
      'watch-history',
      'view_own',
      [friend.id],
      true
    );
    await setExtensionPermissionHolders(
      'watch-history',
      'view_own',
      [friend.id],
      true
    );

    assert.strictEqual(
      await getRepository(ExtensionPermission).countBy({ userId: friend.id }),
      1
    );
  });

  it('revokes only the users named', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    const other = await getRepository(User).save(
      new User({ email: 'stranger@seerr.dev', avatar: '', permissions: 32 })
    );

    await grantExtensionPermission(friend.id, 'watch-history:view_own');
    await grantExtensionPermission(other.id, 'watch-history:view_own');

    await setExtensionPermissionHolders(
      'watch-history',
      'view_own',
      [friend.id],
      false
    );

    assert.deepStrictEqual(await getExtensionPermissions(friend.id), []);
    assert.deepStrictEqual(await getExtensionPermissions(other.id), [
      'watch-history:view_own',
    ]);
  });

  it('leaves another extension grant and an orphaned row alone', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    // `orphan:gone` is declared by nothing — the row a since-uninstalled
    // extension left behind, which a reinstall is meant to restore.
    await grantExtensionPermission(friend.id, [
      'unrequest:remove_own',
      'orphan:gone',
    ]);

    await setExtensionPermissionHolders(
      'watch-history',
      'view_own',
      [friend.id],
      true
    );

    assert.deepStrictEqual(await getExtensionPermissions(friend.id), [
      'orphan:gone',
      'unrequest:remove_own',
      'watch-history:view_own',
    ]);

    await setExtensionPermissionHolders(
      'watch-history',
      'view_own',
      [friend.id],
      false
    );

    assert.deepStrictEqual(await getExtensionPermissions(friend.id), [
      'orphan:gone',
      'unrequest:remove_own',
    ]);
  });

  it('refuses a permission the extension does not declare', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    await assert.rejects(() =>
      setExtensionPermissionHolders(
        'watch-history',
        'not_declared',
        [friend.id],
        true
      )
    );
    assert.deepStrictEqual(await getExtensionPermissions(friend.id), []);
  });

  it('refuses a permission another extension declares', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    await assert.rejects(() =>
      setExtensionPermissionHolders(
        'watch-history',
        'remove_own',
        [friend.id],
        true
      )
    );
  });

  it('writes a row for an admin so the grant survives losing ADMIN', async () => {
    declare();
    const admin = await getUser('admin@seerr.dev');

    await setExtensionPermissionHolders(
      'watch-history',
      'view_own',
      [admin.id],
      true
    );

    assert.deepStrictEqual(await getExtensionPermissions(admin.id), [
      'watch-history:view_own',
    ]);
  });

  it('ignores a user id that does not exist', async () => {
    declare();

    await setExtensionPermissionHolders(
      'watch-history',
      'view_own',
      [9999],
      true
    );

    assert.strictEqual(
      await getRepository(ExtensionPermission).countBy({ userId: 9999 }),
      0
    );
  });

  it('is a no-op for an empty user list', async () => {
    declare();

    await setExtensionPermissionHolders('watch-history', 'view_own', [], true);

    assert.strictEqual(await getRepository(ExtensionPermission).count(), 0);
  });
});

describe('operator-editable permission defaults', () => {
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

  it('falls back to the manifest default with no override recorded', () => {
    declare();

    assert.strictEqual(
      getExtensionPermissionDefault('watch-history', 'view_own'),
      true
    );
    assert.strictEqual(
      getExtensionPermissionDefault('watch-history', 'view_all'),
      false
    );
  });

  it('falls back to false for a permission nothing declares', () => {
    declare();

    assert.strictEqual(
      getExtensionPermissionDefault('nothing', 'at_all'),
      false
    );
  });

  it('persists an override that wins over the manifest', async () => {
    declare();

    await setExtensionPermissionDefault('watch-history', 'view_own', false);
    await setExtensionPermissionDefault('watch-history', 'view_all', true);

    assert.strictEqual(save.mock.callCount(), 2);
    assert.strictEqual(
      getExtensionPermissionDefault('watch-history', 'view_own'),
      false
    );
    assert.strictEqual(
      getExtensionPermissionDefault('watch-history', 'view_all'),
      true
    );
  });

  it('keeps the enabled flag when an override is written', async () => {
    declare();
    getSettings().extensions = { 'watch-history': { enabled: false } };

    await setExtensionPermissionDefault('watch-history', 'view_own', false);

    assert.strictEqual(
      getSettings().extensions['watch-history'].enabled,
      false
    );
    assert.deepStrictEqual(
      getSettings().extensions['watch-history'].permissionDefaults,
      { view_own: false }
    );
  });

  it('clearing an override restores the manifest default', async () => {
    declare();

    await setExtensionPermissionDefault('watch-history', 'view_own', false);
    await clearExtensionPermissionDefaults('watch-history');

    assert.strictEqual(
      getExtensionPermissionDefault('watch-history', 'view_own'),
      true
    );
  });

  it('refuses an override for a permission the extension does not declare', async () => {
    declare();

    await assert.rejects(() =>
      setExtensionPermissionDefault('watch-history', 'not_declared', true)
    );
  });

  it('grants the operator default to a newly created user', async () => {
    declare();

    // `view_all` is `default: false` in the manifest; the operator turns it on.
    await setExtensionPermissionDefault('watch-history', 'view_all', true);
    await setExtensionPermissionDefault('watch-history', 'view_own', false);

    const user = await getRepository(User).save(
      new User({ email: 'newcomer@seerr.dev', avatar: '', permissions: 32 })
    );

    assert.deepStrictEqual(await getExtensionPermissions(user.id), [
      'watch-history:view_all',
    ]);
  });

  it('does not regrant or revoke retroactively when a default changes', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    await grantExtensionPermission(friend.id, 'watch-history:view_own');
    await setExtensionPermissionDefault('watch-history', 'view_own', false);
    await setExtensionPermissionDefault('watch-history', 'view_all', true);

    assert.deepStrictEqual(await getExtensionPermissions(friend.id), [
      'watch-history:view_own',
    ]);
  });
});

/**
 * Stands in for `checkUser`, which needs a session or an API key. The user is
 * loaded through the repository, so `req.user.hasPermission` is the real thing.
 */
const authenticateFromHeader: Middleware = async (req, _res, next) => {
  const email = req.header('x-test-user');

  if (email) {
    req.user = await getRepository(User).findOneOrFail({ where: { email } });
  }

  next();
};

describe('isExtensionAuthenticated', () => {
  function createApp(middleware: Middleware): Express {
    const app = express();
    app.use(express.json());
    app.use(authenticateFromHeader);
    app.get('/probe', middleware, (_req, res) => {
      res.status(200).json({ ok: true });
    });

    return app;
  }

  function probe(app: Express, email?: string) {
    const pending = request(app).get('/probe');

    return email ? pending.set('x-test-user', email) : pending;
  }

  it('403s when there is no authenticated user', async () => {
    const res = await probe(createApp(isExtensionAuthenticated()));

    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(res.body, {
      status: 403,
      error: 'You do not have permission to access this endpoint',
    });
  });

  it('calls next for an authenticated user when nothing is required', async () => {
    const res = await probe(
      createApp(isExtensionAuthenticated()),
      'friend@seerr.dev'
    );

    assert.strictEqual(res.status, 200);
  });

  it('403s without the required extension permission', async () => {
    declare();
    const res = await probe(
      createApp(
        isExtensionAuthenticated({ permission: 'watch-history:view_own' })
      ),
      'friend@seerr.dev'
    );

    assert.strictEqual(res.status, 403);
  });

  it('calls next with the required extension permission', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    await grantExtensionPermission(friend.id, 'watch-history:view_own');

    const res = await probe(
      createApp(
        isExtensionAuthenticated({ permission: 'watch-history:view_own' })
      ),
      'friend@seerr.dev'
    );

    assert.strictEqual(res.status, 200);
  });

  it('namespaces a bare permission key against the extension', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    await grantExtensionPermission(friend.id, 'watch-history:view_own');

    const res = await probe(
      createApp(
        isExtensionAuthenticated({
          extensionId: 'watch-history',
          permission: 'view_own',
        })
      ),
      'friend@seerr.dev'
    );

    assert.strictEqual(res.status, 200);
  });

  it('enforces a core permission on its own', async () => {
    const app = createApp(
      isExtensionAuthenticated({ core: Permission.MANAGE_USERS })
    );

    assert.strictEqual((await probe(app, 'friend@seerr.dev')).status, 403);
    assert.strictEqual((await probe(app, 'admin@seerr.dev')).status, 200);
  });

  it('accepts a core permission named as a string', async () => {
    const app = createApp(isExtensionAuthenticated({ permission: 'REQUEST' }));

    assert.strictEqual((await probe(app, 'friend@seerr.dev')).status, 200);
  });

  it('enforces a core and an extension permission together', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    const app = createApp(
      isExtensionAuthenticated({
        core: Permission.REQUEST,
        permission: 'unrequest:remove_own',
      })
    );

    assert.strictEqual((await probe(app, 'friend@seerr.dev')).status, 403);

    await grantExtensionPermission(friend.id, 'unrequest:remove_own');

    assert.strictEqual((await probe(app, 'friend@seerr.dev')).status, 200);
  });

  it('accepts either requirement when the type is or', async () => {
    declare();
    const app = createApp(
      isExtensionAuthenticated({
        core: Permission.MANAGE_USERS,
        permission: 'watch-history:view_own',
        type: 'or',
      })
    );
    const friend = await getUser('friend@seerr.dev');

    assert.strictEqual((await probe(app, 'friend@seerr.dev')).status, 403);

    await grantExtensionPermission(friend.id, 'watch-history:view_own');

    assert.strictEqual((await probe(app, 'friend@seerr.dev')).status, 200);
  });

  it('lets an admin through an extension permission gate', async () => {
    declare();
    const res = await probe(
      createApp(
        isExtensionAuthenticated({ permission: 'watch-history:view_own' })
      ),
      'admin@seerr.dev'
    );

    assert.strictEqual(res.status, 200);
  });

  it('403s when requiresCore is unmet', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    await grantExtensionPermission(friend.id, 'watch-history:view_all');

    const res = await probe(
      createApp(
        isExtensionAuthenticated({ permission: 'watch-history:view_all' })
      ),
      'friend@seerr.dev'
    );

    assert.strictEqual(res.status, 403);
  });
});

describe('GET|POST /user/:id/settings/extension-permissions', () => {
  const app = express();
  app.use(express.json());
  app.use(authenticateFromHeader);
  app.use('/user', userRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );

  function as(email: string) {
    return { 'x-test-user': email };
  }

  it('reports the granted, effective and available permissions', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    await grantExtensionPermission(friend.id, [
      'watch-history:view_own',
      'watch-history:view_all',
    ]);

    const res = await request(app)
      .get(`/user/${friend.id}/settings/extension-permissions`)
      .set(as('admin@seerr.dev'));

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.permissions, [
      'watch-history:view_all',
      'watch-history:view_own',
    ]);
    // `view_all` is granted but inert: friend holds REQUEST, not MANAGE_USERS.
    assert.deepStrictEqual(res.body.effective, ['watch-history:view_own']);
    assert.deepStrictEqual(
      res.body.available.map(
        (option: { permission: string; requiresCore: string[] }) => [
          option.permission,
          option.requiresCore,
        ]
      ),
      [
        ['watch-history:view_own', []],
        ['watch-history:view_all', ['MANAGE_USERS']],
        ['unrequest:remove_own', ['REQUEST']],
      ]
    );
  });

  it('403s for a user without MANAGE_USERS', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    const res = await request(app)
      .get(`/user/${friend.id}/settings/extension-permissions`)
      .set(as('friend@seerr.dev'));

    assert.strictEqual(res.status, 403);
  });

  it('404s for a user that does not exist', async () => {
    declare();

    const res = await request(app)
      .get('/user/9999/settings/extension-permissions')
      .set(as('admin@seerr.dev'));

    assert.strictEqual(res.status, 404);
  });

  it('replaces the granted permissions', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    await grantExtensionPermission(friend.id, 'watch-history:view_all');

    const res = await request(app)
      .post(`/user/${friend.id}/settings/extension-permissions`)
      .set(as('admin@seerr.dev'))
      .send({ permissions: ['watch-history:view_own'] });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.permissions, ['watch-history:view_own']);
    assert.deepStrictEqual(await getExtensionPermissions(friend.id), [
      'watch-history:view_own',
    ]);
  });

  it('400s on a permission no installed extension declares', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    const res = await request(app)
      .post(`/user/${friend.id}/settings/extension-permissions`)
      .set(as('admin@seerr.dev'))
      .send({ permissions: ['nothing:at_all'] });

    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(await getExtensionPermissions(friend.id), []);
  });

  it('refuses to modify the owner', async () => {
    declare();
    // A second admin, so this exercises the owner guard rather than the
    // self-edit one: `admin@seerr.dev` is itself user 1.
    await getRepository(User).save(
      new User({
        email: 'second-admin@seerr.dev',
        avatar: '',
        permissions: Permission.ADMIN,
      })
    );

    const res = await request(app)
      .post('/user/1/settings/extension-permissions')
      .set(as('second-admin@seerr.dev'))
      .send({ permissions: [] });

    assert.strictEqual(res.status, 403);
  });

  it('refuses to modify your own permissions', async () => {
    declare();
    const self = await getRepository(User).save(
      new User({
        email: 'second-admin@seerr.dev',
        avatar: '',
        permissions: Permission.ADMIN,
      })
    );

    const res = await request(app)
      .post(`/user/${self.id}/settings/extension-permissions`)
      .set(as('second-admin@seerr.dev'))
      .send({ permissions: [] });

    assert.strictEqual(res.status, 403);
  });
});
