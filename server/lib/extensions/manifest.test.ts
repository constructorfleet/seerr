import {
  ManifestValidationError,
  parseManifest,
} from '@server/lib/extensions/manifest';
import { Permission } from '@server/lib/permissions';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * The Watch History manifest exactly as written in
 * `docs/specs/extension-system.md`. Kept verbatim so a schema change that
 * breaks the documented example fails here.
 */
const watchHistoryManifest = () => ({
  id: 'watch-history',
  name: 'Watch History',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  server: 'dist/server.js',
  requires: {
    users: 'read',
    media: 'read',
    requests: 'read',
    settings: 'read',
    store: true,
    jobs: true,
    http: ['plex.tv'],
  },
  provides: {
    permissions: [
      { key: 'view_own', name: 'View Own History', default: true },
      {
        key: 'view_all',
        name: 'View All History',
        requiresCore: ['MANAGE_USERS'],
      },
    ],
    notifications: [
      { key: 'milestone', name: 'Watch Milestone', default: false },
    ],
    panels: [
      {
        slug: 'history',
        title: 'Watch History',
        entry: 'dist/panel.js',
        sidebar: { icon: 'ClockIcon', order: 50 },
        permission: 'view_own',
      },
    ],
    jobs: [{ id: 'sync', name: 'Sync Watch History', schedule: '0 */6 * * *' }],
  },
});

/** The second reference extension from the spec. */
const unrequestManifest = () => ({
  id: 'unrequest',
  name: 'Unrequest',
  version: '0.2.1',
  apiVersion: '^1.0.0',
  server: 'dist/server.js',
  requires: {
    users: 'read',
    media: 'write',
    requests: 'write',
    store: true,
  },
  provides: {
    permissions: [
      {
        key: 'remove_own',
        name: 'Withdraw Own Requests',
        description: 'Allows a user to withdraw media they requested.',
        default: true,
        requiresCore: ['REQUEST'],
      },
      {
        key: 'manage_removals',
        name: 'Manage Removals',
        requiresCore: ['MANAGE_REQUESTS'],
      },
    ],
    notifications: [
      { key: 'removal_pending', name: 'Removal Requested', default: true },
    ],
    panels: [
      {
        slug: 'removals',
        title: 'Removals',
        entry: 'dist/panel.js',
        permission: 'manage_removals',
      },
    ],
  },
});

/** The smallest manifest the schema should accept. */
const minimalManifest = () => ({
  id: 'minimal',
  name: 'Minimal',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  server: 'index.js',
});

/**
 * Asserts that `raw` is rejected with an issue at `path` (a dot-joined issue
 * path, `''` for the manifest itself). Issue paths rather than message text:
 * the message begins "Invalid extension manifest", which makes a loose
 * `/id/`-style match pass for any failure at all.
 */
function assertRejects(
  raw: unknown,
  path: string
): { error: ManifestValidationError; paths: string[] } {
  let error: unknown;

  try {
    parseManifest(raw);
  } catch (e) {
    error = e;
  }

  assert.ok(
    error instanceof ManifestValidationError,
    `expected a ManifestValidationError, got ${error}`
  );

  const paths = error.issues.map((issue) => issue.path.join('.'));
  assert.ok(
    paths.includes(path),
    `expected an issue at "${path}", got ${JSON.stringify(paths)}`
  );

  return { error, paths };
}

describe('parseManifest', () => {
  it('accepts the Watch History reference manifest from the spec', () => {
    const manifest = parseManifest(watchHistoryManifest());

    assert.strictEqual(manifest.id, 'watch-history');
    assert.strictEqual(manifest.version, '1.0.0');
    assert.strictEqual(manifest.apiVersion, '^1.0.0');
    assert.strictEqual(manifest.server, 'dist/server.js');
  });

  it('accepts the Unrequest reference manifest', () => {
    const manifest = parseManifest(unrequestManifest());

    assert.strictEqual(manifest.id, 'unrequest');
    assert.deepStrictEqual(manifest.provides?.permissions?.[0].requiresCore, [
      'REQUEST',
    ]);
  });

  it('accepts a manifest that declares no capabilities and provides nothing', () => {
    const manifest = parseManifest(minimalManifest());

    assert.strictEqual(manifest.requires, undefined);
    assert.strictEqual(manifest.provides, undefined);
  });

  it('preserves declared capabilities verbatim', () => {
    const { requires } = parseManifest(watchHistoryManifest());

    assert.deepStrictEqual(requires, {
      users: 'read',
      media: 'read',
      requests: 'read',
      settings: 'read',
      store: true,
      jobs: true,
      http: ['plex.tv'],
    });
  });

  it('preserves every provided panel, notification, and job', () => {
    const { provides } = parseManifest(watchHistoryManifest());

    assert.deepStrictEqual(provides?.panels, [
      {
        slug: 'history',
        title: 'Watch History',
        entry: 'dist/panel.js',
        sidebar: { icon: 'ClockIcon', order: 50 },
        permission: 'view_own',
      },
    ]);
    assert.deepStrictEqual(provides?.notifications, [
      { key: 'milestone', name: 'Watch Milestone', default: false },
    ]);
    assert.deepStrictEqual(provides?.jobs, [
      { id: 'sync', name: 'Sync Watch History', schedule: '0 */6 * * *' },
    ]);
  });

  it('rejects input that is not an object', () => {
    assertRejects('watch-history', '');
    assertRejects(null, '');
    assertRejects([watchHistoryManifest()], '');
  });

  it('rejects a manifest missing required fields', () => {
    const { paths } = assertRejects({ id: 'watch-history' }, 'name');

    assert.deepStrictEqual(paths.sort(), [
      'apiVersion',
      'name',
      'server',
      'version',
    ]);
  });

  it('names every problem it found, not just the first', () => {
    const { paths } = assertRejects(
      { id: 'Watch History', name: 'Watch History', version: 'one' },
      'id'
    );

    assert.deepStrictEqual(paths.sort(), [
      'apiVersion',
      'id',
      'server',
      'version',
    ]);
  });
});

describe('parseManifest id validation', () => {
  const rejectedIds = [
    ['an uppercase id', 'WatchHistory'],
    ['a leading digit', '1watch'],
    ['a leading hyphen', '-watch'],
    ['an underscore', 'watch_history'],
    ['a path traversal attempt', '../../etc/passwd'],
    ['a relative path segment', '..'],
    ['a slash', 'watch/history'],
    ['a dot', 'watch.history'],
    ['a space', 'watch history'],
    ['a SQL quote', "watch'; drop table user; --"],
    ['a backtick', 'watch`history'],
    ['an empty string', ''],
  ] as const;

  // `id` prefixes table names, URL segments, and permission keys, so anything
  // outside the conservative pattern is a schema-injection risk.
  for (const [label, id] of rejectedIds) {
    it(`rejects ${label}`, () => {
      assertRejects({ ...watchHistoryManifest(), id }, 'id');
    });
  }

  it('accepts a lowercase hyphenated id', () => {
    assert.strictEqual(
      parseManifest({ ...watchHistoryManifest(), id: 'a1-b2-c3' }).id,
      'a1-b2-c3'
    );
  });

  it('rejects an id that claims a core table', () => {
    // `notification` is a valid id by pattern, but it yields the table prefix
    // `ext_notification_` — which core's own `ext_notification_subscription`
    // begins with. Uninstalling it would drop that table.
    const { error } = assertRejects(
      { ...watchHistoryManifest(), id: 'notification' },
      'id'
    );

    assert.match(error.message, /ext_notification_subscription/);
  });

  it('accepts an id that merely shares a prefix with a core table', () => {
    // `ext_permission_` is not a prefix of `ext_permission`, so nothing collides:
    // only an id that is a core table name minus a trailing segment does.
    for (const id of [
      'permission',
      'kv',
      'notification-digest',
      'notifications',
    ]) {
      assert.strictEqual(
        parseManifest({ ...watchHistoryManifest(), id }).id,
        id
      );
    }
  });
});

describe('parseManifest version validation', () => {
  it('rejects a version that is not valid semver', () => {
    for (const version of ['1.0', 'latest', '^1.0.0', '']) {
      assertRejects({ ...watchHistoryManifest(), version }, 'version');
    }
  });

  it('accepts a prerelease version', () => {
    assert.strictEqual(
      parseManifest({ ...watchHistoryManifest(), version: '2.0.0-beta.1' })
        .version,
      '2.0.0-beta.1'
    );
  });

  it('rejects an apiVersion that is not a valid semver range', () => {
    for (const apiVersion of ['nonsense', 'latest', '^1.0.0 || garbage']) {
      assertRejects({ ...watchHistoryManifest(), apiVersion }, 'apiVersion');
    }
  });

  it('rejects an empty apiVersion rather than treating it as "any version"', () => {
    // `semver.validRange('')` is `*`, which would silently make an empty
    // apiVersion compatible with every host.
    assertRejects({ ...watchHistoryManifest(), apiVersion: '' }, 'apiVersion');
  });

  it('accepts the semver range forms an extension is likely to use', () => {
    for (const apiVersion of ['^1.0.0', '~1.2.3', '1.x', '>=1.0.0 <2.0.0']) {
      assert.strictEqual(
        parseManifest({ ...watchHistoryManifest(), apiVersion }).apiVersion,
        apiVersion
      );
    }
  });
});

describe('parseManifest entry point validation', () => {
  const rejectedPaths = [
    ['an absolute path', '/etc/passwd'],
    ['a parent directory escape', '../../../etc/passwd'],
    ['a parent directory segment', 'dist/../../server.js'],
    ['a Windows separator', 'dist\\server.js'],
    ['an empty path', ''],
  ] as const;

  for (const [label, server] of rejectedPaths) {
    it(`rejects ${label} as the server entry`, () => {
      assertRejects({ ...watchHistoryManifest(), server }, 'server');
    });
  }

  it('rejects a panel entry that escapes the extension directory', () => {
    const manifest = watchHistoryManifest();
    manifest.provides.panels[0].entry = '../../../../etc/passwd';

    assertRejects(manifest, 'provides.panels.0.entry');
  });
});

describe('parseManifest requires validation', () => {
  it('rejects an unknown capability', () => {
    const manifest = watchHistoryManifest();

    // Zod reports an unrecognized key against the object containing it, so the
    // key itself is asserted through the message.
    const { error } = assertRejects(
      { ...manifest, requires: { ...manifest.requires, database: true } },
      'requires'
    );
    assert.match(error.message, /Unrecognized key: "database"/);
  });

  it('rejects an unknown access level', () => {
    const manifest = watchHistoryManifest();

    assertRejects(
      { ...manifest, requires: { ...manifest.requires, users: 'admin' } },
      'requires.users'
    );
  });

  it('rejects write access to settings, which the SDK only exposes read-only', () => {
    const manifest = watchHistoryManifest();

    assertRejects(
      { ...manifest, requires: { ...manifest.requires, settings: 'write' } },
      'requires.settings'
    );
  });

  it('rejects an http allowlist entry that is not a bare hostname', () => {
    const manifest = watchHistoryManifest();

    for (const host of ['https://plex.tv', 'plex.tv/api', '']) {
      assertRejects(
        { ...manifest, requires: { ...manifest.requires, http: [host] } },
        'requires.http.0'
      );
    }
  });
});

describe('parseManifest permission validation', () => {
  it('rejects a requiresCore entry that is not a core Permission member', () => {
    const manifest = watchHistoryManifest();
    manifest.provides.permissions[1].requiresCore = ['MANAGE_USER'];

    const { error } = assertRejects(
      manifest,
      'provides.permissions.1.requiresCore.0'
    );
    assert.match(error.message, /MANAGE_USER/);
  });

  it('rejects a lowercased core permission name', () => {
    const manifest = watchHistoryManifest();
    manifest.provides.permissions[1].requiresCore = ['manage_users'];

    assertRejects(manifest, 'provides.permissions.1.requiresCore.0');
  });

  it('rejects NONE, which would grant unconditionally', () => {
    const manifest = watchHistoryManifest();
    manifest.provides.permissions[1].requiresCore = ['NONE'];

    assertRejects(manifest, 'provides.permissions.1.requiresCore.0');
  });

  it('accepts every usable core Permission member', () => {
    const names = Object.keys(Permission).filter(
      (name) => name !== 'NONE' && isNaN(Number(name))
    );
    const manifest = watchHistoryManifest();
    manifest.provides.permissions[1].requiresCore = names;

    assert.deepStrictEqual(
      parseManifest(manifest).provides?.permissions?.[1].requiresCore,
      names
    );
  });

  it('rejects a permission key outside the slug pattern', () => {
    const manifest = watchHistoryManifest();
    manifest.provides.permissions[0].key = 'View Own';

    assertRejects(manifest, 'provides.permissions.0.key');
  });

  it('rejects duplicate permission keys, which would collide once namespaced', () => {
    const manifest = watchHistoryManifest();
    manifest.provides.permissions[1].key = 'view_own';

    const { error } = assertRejects(manifest, 'provides.permissions.1.key');
    assert.match(error.message, /Duplicate key "view_own"/);
  });
});

describe('parseManifest notification validation', () => {
  it('rejects a notification key outside the slug pattern', () => {
    const manifest = watchHistoryManifest();
    manifest.provides.notifications[0].key = 'Watch Milestone';

    assertRejects(manifest, 'provides.notifications.0.key');
  });

  it('rejects duplicate notification keys', () => {
    const manifest = watchHistoryManifest();
    manifest.provides.notifications.push({
      key: 'milestone',
      name: 'Another Milestone',
      default: true,
    });

    assertRejects(manifest, 'provides.notifications.1.key');
  });
});

describe('parseManifest panel validation', () => {
  it('rejects a panel slug outside the slug pattern, since it becomes a URL segment', () => {
    const manifest = watchHistoryManifest();
    manifest.provides.panels[0].slug = 'Watch History';

    assertRejects(manifest, 'provides.panels.0.slug');
  });

  it('rejects duplicate panel slugs', () => {
    const manifest = watchHistoryManifest();
    manifest.provides.panels.push({
      ...manifest.provides.panels[0],
      title: 'Duplicate',
    });

    assertRejects(manifest, 'provides.panels.1.slug');
  });

  it('rejects a panel permission that is neither declared nor a core permission', () => {
    const manifest = watchHistoryManifest();
    manifest.provides.panels[0].permission = 'view_onw';

    const { error } = assertRejects(manifest, 'provides.panels.0.permission');
    assert.match(error.message, /view_onw/);
  });

  it('accepts a panel gated on a core permission', () => {
    const manifest = watchHistoryManifest();
    manifest.provides.panels[0].permission = 'MANAGE_USERS';

    assert.strictEqual(
      parseManifest(manifest).provides?.panels?.[0].permission,
      'MANAGE_USERS'
    );
  });

  it('accepts a panel with no sidebar entry', () => {
    const manifest = unrequestManifest();

    assert.strictEqual(
      parseManifest(manifest).provides?.panels?.[0].sidebar,
      undefined
    );
  });

  it('rejects a sidebar icon that is not a heroicon name', () => {
    const manifest = watchHistoryManifest();
    manifest.provides.panels[0].sidebar.icon = 'clock';

    assertRejects(manifest, 'provides.panels.0.sidebar.icon');
  });

  it('rejects a non-integer sidebar order', () => {
    const manifest = watchHistoryManifest();
    manifest.provides.panels[0].sidebar.order = 1.5;

    assertRejects(manifest, 'provides.panels.0.sidebar.order');
  });
});

describe('parseManifest job validation', () => {
  it('rejects a job id outside the slug pattern', () => {
    const manifest = watchHistoryManifest();
    manifest.provides.jobs[0].id = 'Sync Watch History';

    assertRejects(manifest, 'provides.jobs.0.id');
  });

  it('rejects duplicate job ids', () => {
    const manifest = watchHistoryManifest();
    manifest.provides.jobs.push({
      id: 'sync',
      name: 'Sync Again',
      schedule: '0 0 * * *',
    });

    assertRejects(manifest, 'provides.jobs.1.id');
  });

  it('rejects a schedule that is not a cron expression', () => {
    const manifest = watchHistoryManifest();

    for (const schedule of ['every 6 hours', '0 */6 * *', '99 * * * *', '']) {
      manifest.provides.jobs[0].schedule = schedule;
      assertRejects(manifest, 'provides.jobs.0.schedule');
    }
  });

  it('accepts the cron forms core jobs use', () => {
    const manifest = watchHistoryManifest();

    for (const schedule of ['0 */6 * * *', '*/5 * * * *', '0 0 * * MON']) {
      manifest.provides.jobs[0].schedule = schedule;
      assert.strictEqual(
        parseManifest(manifest).provides?.jobs?.[0].schedule,
        schedule
      );
    }
  });
});

describe('parseManifest settings validation', () => {
  /** A manifest declaring one setting of each type, with every field exercised. */
  const settingsManifest = () => ({
    ...minimalManifest(),
    provides: {
      settings: [
        {
          key: 'enabled',
          type: 'boolean',
          name: 'Enabled',
          description: 'Whether to do the thing.',
          default: true,
        },
        { key: 'endpoint', type: 'string', name: 'Endpoint', required: true },
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
          default: 'jellyfin',
          options: [
            { value: 'plex', label: 'Plex' },
            { value: 'jellyfin', label: 'Jellyfin' },
          ],
        },
        { key: 'api_token', type: 'secret', name: 'API Token' },
      ],
    },
  });

  it('accepts a declaration of every field type', () => {
    const { provides } = parseManifest(settingsManifest());

    assert.deepStrictEqual(
      provides?.settings?.map((setting) => setting.type),
      ['boolean', 'string', 'number', 'select', 'secret']
    );
  });

  it('preserves every declared field verbatim', () => {
    const { provides } = parseManifest(settingsManifest());

    assert.deepStrictEqual(provides?.settings?.[2], {
      key: 'batch_size',
      type: 'number',
      name: 'Batch Size',
      default: 25,
      min: 1,
      max: 100,
    });
    assert.deepStrictEqual(provides?.settings?.[3].options, [
      { value: 'plex', label: 'Plex' },
      { value: 'jellyfin', label: 'Jellyfin' },
    ]);
  });

  it('rejects a key outside the slug pattern', () => {
    const manifest = settingsManifest();
    manifest.provides.settings[0].key = 'API Token';

    assertRejects(manifest, 'provides.settings.0.key');
  });

  it('rejects duplicate keys, which would collide in the value record', () => {
    const manifest = settingsManifest();
    manifest.provides.settings[1].key = 'enabled';

    const { error } = assertRejects(manifest, 'provides.settings.1.key');
    assert.match(error.message, /Duplicate key "enabled"/);
  });

  it('rejects an unknown field type', () => {
    const manifest = settingsManifest();
    manifest.provides.settings[1].type = 'password';

    assertRejects(manifest, 'provides.settings.1.type');
  });

  it('rejects a missing name', () => {
    const manifest = settingsManifest();
    manifest.provides.settings[1].name = '';

    assertRejects(manifest, 'provides.settings.1.name');
  });

  it('rejects a secret that declares a default', () => {
    // Shipping a credential in the manifest: readable in the install directory,
    // the same on every install, and in effect for anyone who never opens the
    // form.
    const manifest = settingsManifest();
    manifest.provides.settings[4].default = 'hunter2';

    const { error } = assertRejects(manifest, 'provides.settings.4.default');
    assert.match(error.message, /secret must not declare a default/);
  });

  it('rejects a select with no options', () => {
    const manifest = settingsManifest();
    delete manifest.provides.settings[3].options;

    const { error } = assertRejects(manifest, 'provides.settings.3.options');
    assert.match(error.message, /select must declare options/);
  });

  it('rejects a select with an empty options array', () => {
    const manifest = settingsManifest();
    manifest.provides.settings[3].options = [];

    assertRejects(manifest, 'provides.settings.3.options');
  });

  it('rejects options on a field that is not a select', () => {
    const manifest = settingsManifest();
    manifest.provides.settings[1].options = [{ value: 'a', label: 'A' }];

    const { error } = assertRejects(manifest, 'provides.settings.1.options');
    assert.match(error.message, /only valid for a select, not "string"/);
  });

  it('rejects min or max on a field that is not a number', () => {
    for (const [index, bound] of [
      [1, 'min'],
      [1, 'max'],
      [4, 'min'],
    ] as const) {
      const manifest = settingsManifest();
      manifest.provides.settings[index][bound] = 5;

      const { error } = assertRejects(
        manifest,
        `provides.settings.${index}.${bound}`
      );
      assert.match(error.message, new RegExp(`${bound} is only valid`));
    }
  });

  it('rejects a max below its min', () => {
    const manifest = settingsManifest();
    manifest.provides.settings[2].min = 100;
    manifest.provides.settings[2].max = 1;

    assertRejects(manifest, 'provides.settings.2.max');
  });

  it('rejects a default that does not typecheck against the declared type', () => {
    for (const [index, badDefault] of [
      [0, 'yes'],
      [1, 42],
      [2, 'many'],
      [3, true],
    ] as const) {
      const manifest = settingsManifest();
      manifest.provides.settings[index].default = badDefault;

      const { error } = assertRejects(
        manifest,
        `provides.settings.${index}.default`
      );
      assert.match(error.message, /is not a/);
    }
  });

  it('rejects a select default that is not one of its options', () => {
    const manifest = settingsManifest();
    manifest.provides.settings[3].default = 'emby';

    const { error } = assertRejects(manifest, 'provides.settings.3.default');
    assert.match(error.message, /not one of the declared options/);
  });

  it('rejects a default outside its own declared bounds', () => {
    // Otherwise the form opens on a value the operator cannot re-submit without
    // changing it, and an extension nobody configured runs on an out-of-range
    // number its own manifest called illegal.
    for (const [bound, value, expected] of [
      ['min', 0, /below min/],
      ['max', 1000, /above max/],
    ] as const) {
      const manifest = settingsManifest();
      manifest.provides.settings[2].default = value;

      const { error } = assertRejects(manifest, 'provides.settings.2.default');
      assert.match(error.message, expected, `for ${bound}`);
    }
  });

  it('accepts a default at either bound, which is inclusive', () => {
    for (const value of [1, 100]) {
      const manifest = settingsManifest();
      manifest.provides.settings[2].default = value;

      assert.strictEqual(
        parseManifest(manifest).provides?.settings?.[2].default,
        value
      );
    }
  });

  it('rejects an unknown field on a setting', () => {
    const manifest = settingsManifest();

    const { error } = assertRejects(
      {
        ...manifest,
        provides: {
          settings: [{ ...manifest.provides.settings[1], placeholder: 'url' }],
        },
      },
      'provides.settings.0'
    );
    assert.match(error.message, /Unrecognized key: "placeholder"/);
  });

  it('accepts an extension that declares no settings', () => {
    assert.strictEqual(
      parseManifest(watchHistoryManifest()).provides?.settings,
      undefined
    );
  });
});

describe('parseManifest strictness', () => {
  it('rejects an unknown top-level field so manifest typos surface loudly', () => {
    const { error } = assertRejects(
      { ...watchHistoryManifest(), sever: 'dist/server.js' },
      ''
    );
    assert.match(error.message, /Unrecognized key: "sever"/);
  });

  it('rejects an unknown field inside provides', () => {
    const manifest = watchHistoryManifest();

    const { error } = assertRejects(
      { ...manifest, provides: { ...manifest.provides, widgets: [] } },
      'provides'
    );
    assert.match(error.message, /Unrecognized key: "widgets"/);
  });

  it('rejects an unknown field on a panel', () => {
    const manifest = watchHistoryManifest();

    const { error } = assertRejects(
      {
        ...manifest,
        provides: {
          ...manifest.provides,
          panels: [{ ...manifest.provides.panels[0], route: '/history' }],
        },
      },
      'provides.panels.0'
    );
    assert.match(error.message, /Unrecognized key: "route"/);
  });

  it('rejects an unknown field on a permission', () => {
    const manifest = watchHistoryManifest();

    // A `requires` on a permission is the shape core's `PermissionItem` uses;
    // the manifest field is `requiresCore`, and the typo must not be ignored.
    const { error } = assertRejects(
      {
        ...manifest,
        provides: {
          ...manifest.provides,
          permissions: [
            { ...manifest.provides.permissions[0], requires: ['REQUEST'] },
          ],
        },
      },
      'provides.permissions.0'
    );
    assert.match(error.message, /Unrecognized key: "requires"/);
  });
});
