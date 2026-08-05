/**
 * The self-service extension endpoints: which panels the signed-in user may open,
 * and which extension permissions they hold.
 *
 * These exist because slice 4's permission endpoint is `MANAGE_USERS`-gated and
 * keyed by *another* user's id, so an ordinary user cannot read their own
 * extension permissions — which is exactly what the sidebar, the panel page, and
 * a panel's own UI gating need. Resolution happens on the server because
 * extension permissions are rows, not bits on the user.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import type { ExtensionManifest } from '@server/lib/extensions/manifest';
import {
  grantExtensionPermission,
  setExtensionPermissionDeclarations,
} from '@server/lib/extensions/permissions';
import type { ExtensionEntry } from '@server/lib/extensions/registry';
import {
  ExtensionRegistrations,
  ExtensionRegistry,
} from '@server/lib/extensions/registry';
import { getSettings } from '@server/lib/settings';
import { setExtensionRegistry } from '@server/routes/settings/extensions';
import { setupTestDb } from '@server/test/db';

setupTestDb();

const API_KEY = 'extension-panel-list-test-api-key';
const API_SPEC_PATH = path.join(__dirname, '../../seerr-api.yml');

let priorApiKey: string;

before(() => {
  priorApiKey = getSettings().main.apiKey;
  getSettings().main.apiKey = API_KEY;
});

after(() => {
  getSettings().main.apiKey = priorApiKey;
  setExtensionRegistry(undefined);
  setExtensionPermissionDeclarations(() => []);
});

interface FakePanel {
  slug: string;
  title?: string;
  permission?: string;
  sidebar?: { icon: string; order?: number };
}

function registryWith(
  extensions: { id: string; panels: FakePanel[]; failed?: boolean }[]
): ExtensionRegistry {
  const registry = new ExtensionRegistry();

  for (const extension of extensions) {
    const entry: ExtensionEntry = {
      id: extension.id,
      directory: `/tmp/${extension.id}`,
      manifest: {
        id: extension.id,
        name: extension.id,
        version: '1.0.0',
        provides: {
          panels: extension.panels.map((panel) => ({
            slug: panel.slug,
            title: panel.title ?? panel.slug,
            entry: 'dist/panel.mjs',
            ...(panel.permission ? { permission: panel.permission } : {}),
            ...(panel.sidebar ? { sidebar: panel.sidebar } : {}),
          })),
        },
      } as unknown as ExtensionManifest,
      status: 'pending',
      entities: [],
      migrations: [],
    };
    registry.add(entry);

    if (extension.failed) {
      registry.fail(entry.id, new Error('boom'), 'running its entry point');
    } else {
      registry.commit(entry, new ExtensionRegistrations());
    }
  }

  return registry;
}

/**
 * The panel list as `server/routes/index.ts` mounts it: behind `checkUser` and
 * the OpenAPI validator, because this is a fixed core path and so must be
 * documented in `seerr-api.yml` like any other (unlike an extension's own
 * routes, whose paths are unknown at build time).
 */
async function createApp() {
  const express = (await import('express')).default;
  const OpenApiValidator = await import('express-openapi-validator');
  const { checkUser } = await import('@server/middleware/auth');
  const { default: selfServiceRoutes } =
    await import('@server/routes/extensionSelfService');

  const app = express();
  app.use(checkUser);
  app.use(
    OpenApiValidator.middleware({
      apiSpec: API_SPEC_PATH,
      validateRequests: true,
      validateResponses: true,
    })
  );
  app.use('/api/v1/extensions', selfServiceRoutes);

  return app;
}

async function getAs(userEmail: string, endpoint: string) {
  const request = (await import('supertest')).default;
  const app = await createApp();
  const user = await getRepository(User).findOneOrFail({
    where: { email: userEmail },
  });

  return request(app)
    .get(`/api/v1/extensions/${endpoint}`)
    .set('X-API-Key', API_KEY)
    .set('X-API-User', String(user.id));
}

function get(userEmail: string) {
  return getAs(userEmail, 'panels');
}

describe('extension panel list', () => {
  it('lists an ungated panel for an ordinary user', async () => {
    setExtensionRegistry(
      registryWith([
        {
          id: 'demo',
          panels: [
            {
              slug: 'dashboard',
              title: 'Dashboard',
              sidebar: { icon: 'ChartBarIcon' },
            },
          ],
        },
      ])
    );

    const res = await get('friend@seerr.dev');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [
      {
        extensionId: 'demo',
        slug: 'dashboard',
        title: 'Dashboard',
        href: '/extensions/demo/dashboard',
        bundleUrl: '/api/v1/ext/demo/ui/dashboard.mjs',
        sidebar: { icon: 'ChartBarIcon' },
      },
    ]);
  });

  it('omits a panel whose permission the user lacks', async () => {
    setExtensionRegistry(
      registryWith([
        {
          id: 'demo',
          panels: [
            { slug: 'open' },
            { slug: 'jealous', permission: 'demo:secret' },
          ],
        },
      ])
    );
    setExtensionPermissionDeclarations(() => [
      {
        extensionId: 'demo',
        permission: 'demo:secret',
        key: 'secret',
        name: 'See the secret panel',
        default: false,
        requiresCore: [],
      },
    ]);

    const res = await get('friend@seerr.dev');

    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.map((panel: { slug: string }) => panel.slug),
      ['open']
    );
  });

  it('includes a gated panel once the permission is granted', async () => {
    setExtensionRegistry(
      registryWith([
        {
          id: 'demo',
          panels: [{ slug: 'jealous', permission: 'demo:secret' }],
        },
      ])
    );
    setExtensionPermissionDeclarations(() => [
      {
        extensionId: 'demo',
        permission: 'demo:secret',
        key: 'secret',
        name: 'See the secret panel',
        default: false,
        requiresCore: [],
      },
    ]);

    const friend = await getRepository(User).findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });
    await grantExtensionPermission(friend.id, 'demo:secret');

    const res = await get('friend@seerr.dev');

    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
  });

  it('shows an admin every panel', async () => {
    setExtensionRegistry(
      registryWith([
        {
          id: 'demo',
          panels: [
            { slug: 'open' },
            { slug: 'jealous', permission: 'demo:secret' },
          ],
        },
      ])
    );

    const res = await get('admin@seerr.dev');

    assert.equal(res.status, 200);
    assert.equal(res.body.length, 2);
  });

  it('lists nothing for an extension that failed to activate', async () => {
    setExtensionRegistry(
      registryWith([
        { id: 'demo', panels: [{ slug: 'dashboard' }], failed: true },
      ])
    );

    const res = await get('admin@seerr.dev');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  it('orders sidebar panels by their declared order, then title', async () => {
    setExtensionRegistry(
      registryWith([
        {
          id: 'demo',
          panels: [
            {
              slug: 'third',
              title: 'Charlie',
              sidebar: { icon: 'CogIcon', order: 20 },
            },
            {
              slug: 'first',
              title: 'Alpha',
              sidebar: { icon: 'CogIcon', order: 10 },
            },
            { slug: 'second', title: 'Bravo', sidebar: { icon: 'CogIcon' } },
          ],
        },
      ])
    );

    const res = await get('admin@seerr.dev');

    // An unordered sidebar panel sorts after ordered ones, so an extension that
    // states no preference does not jump ahead of one that did.
    assert.deepEqual(
      res.body.map((panel: { slug: string }) => panel.slug),
      ['first', 'third', 'second']
    );
  });

  it('returns an empty list when no registry is wired', async () => {
    setExtensionRegistry(undefined);

    const res = await get('admin@seerr.dev');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });
});

describe("a user's own effective extension permissions", () => {
  it('reports a granted permission to the user who holds it', async () => {
    setExtensionPermissionDeclarations(() => [
      {
        extensionId: 'demo',
        permission: 'demo:view',
        key: 'view',
        name: 'View',
        default: false,
        requiresCore: [],
      },
    ]);

    const friend = await getRepository(User).findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    // Before the grant. This is the case slice 4's endpoint cannot answer for a
    // non-admin at all, which is why this route exists.
    assert.deepEqual((await getAs('friend@seerr.dev', 'permissions')).body, {
      permissions: [],
    });

    await grantExtensionPermission(friend.id, 'demo:view');

    const res = await getAs('friend@seerr.dev', 'permissions');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { permissions: ['demo:view'] });
  });

  it('reports every declared permission to an admin', async () => {
    setExtensionPermissionDeclarations(() => [
      {
        extensionId: 'demo',
        permission: 'demo:view',
        key: 'view',
        name: 'View',
        default: false,
        requiresCore: [],
      },
    ]);

    // Matching core `hasPermission`'s ADMIN short-circuit, so an admin is never
    // locked out of a panel.
    const res = await getAs('admin@seerr.dev', 'permissions');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { permissions: ['demo:view'] });
  });
});
