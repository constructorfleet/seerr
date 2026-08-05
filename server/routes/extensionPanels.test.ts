/**
 * The route that serves an extension's pre-built panel bundle.
 *
 * Two things make this more than a static-file mount. First, the file comes
 * from an extension's own directory, so the path a request names must not be
 * able to reach outside it. Second, a panels-only extension registers no
 * *routes*, and the router previously created a sub-router only for extensions
 * that did — so bundle serving has to be registered independently of that.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
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
import { createExtensionRouter } from '@server/routes/extension';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import request from 'supertest';

setupTestDb();

const API_KEY = 'extension-panel-route-test-api-key';

let priorApiKey: string;
let root: string;

const BUNDLE = 'export default function Panel() { return null; }\n';

before(async () => {
  priorApiKey = getSettings().main.apiKey;
  getSettings().main.apiKey = API_KEY;

  root = await fs.mkdtemp(path.join(os.tmpdir(), 'seerr-panels-'));

  await fs.mkdir(path.join(root, 'demo', 'dist'), { recursive: true });
  await fs.writeFile(path.join(root, 'demo', 'dist', 'panel.mjs'), BUNDLE);
  // A file the extension ships but no panel declares, used to check that only
  // declared entry files are reachable.
  await fs.writeFile(path.join(root, 'demo', 'secrets.json'), '{"token":"x"}');
  // Outside every extension directory: the target of a traversal attempt.
  await fs.writeFile(path.join(root, 'outside.mjs'), BUNDLE);
});

after(async () => {
  getSettings().main.apiKey = priorApiKey;
  setExtensionPermissionDeclarations(() => []);
  await fs.rm(root, { recursive: true, force: true });
});

/** An active extension declaring one panel whose entry is `dist/panel.mjs`. */
function registryWithPanel(
  overrides: {
    slug?: string;
    entry?: string;
    failed?: boolean;
    permission?: string;
  } = {}
): ExtensionRegistry {
  const registry = new ExtensionRegistry();

  const manifest = {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    provides: {
      panels: [
        {
          slug: overrides.slug ?? 'dashboard',
          title: 'Dashboard',
          entry: overrides.entry ?? 'dist/panel.mjs',
          ...(overrides.permission ? { permission: overrides.permission } : {}),
        },
      ],
    },
  } as unknown as ExtensionManifest;

  const entry: ExtensionEntry = {
    id: 'demo',
    directory: path.join(root, 'demo'),
    manifest,
    status: 'pending',
    entities: [],
    migrations: [],
  };
  registry.add(entry);

  if (overrides.failed) {
    registry.fail(entry.id, new Error('boom'), 'running its entry point');
  } else {
    registry.commit(entry, new ExtensionRegistrations());
  }

  return registry;
}

function appFor(registry: ExtensionRegistry) {
  const app = express();
  app.use('/api/v1/ext', createExtensionRouter(registry));
  return app;
}

function asUser(pending: request.Test, userId = 1): request.Test {
  return pending.set('X-API-Key', API_KEY).set('X-API-User', String(userId));
}

describe('extension panel bundle route', () => {
  it("serves a panels-only extension's bundle", async () => {
    // The extension registered no routes at all. It still needs a bundle route,
    // which is why bundle serving cannot hang off `routesFor()`.
    const res = await asUser(
      request(appFor(registryWithPanel())).get(
        '/api/v1/ext/demo/ui/dashboard.mjs'
      )
    );

    assert.equal(res.status, 200);
    assert.equal(res.text, BUNDLE);
    assert.match(res.headers['content-type'], /javascript/);
  });

  it('requires a signed-in user', async () => {
    const res = await request(appFor(registryWithPanel())).get(
      '/api/v1/ext/demo/ui/dashboard.mjs'
    );

    assert.equal(res.status, 403);
  });

  it('serves nothing for an extension that failed to activate', async () => {
    const res = await asUser(
      request(appFor(registryWithPanel({ failed: true }))).get(
        '/api/v1/ext/demo/ui/dashboard.mjs'
      )
    );

    assert.equal(res.status, 404);
  });

  it('serves only declared panel slugs', async () => {
    const app = appFor(registryWithPanel());

    // The bundle is addressed by *slug*, not by path, so a file the extension
    // ships but does not declare as a panel entry is simply not addressable.
    for (const target of [
      'other.mjs',
      'secrets.json',
      '..%2f..%2foutside.mjs',
      '..%2fdemo%2fsecrets.json',
      '%2e%2e/outside.mjs',
    ]) {
      const res = await asUser(
        request(app).get(`/api/v1/ext/demo/ui/${target}`)
      );

      assert.equal(res.status, 404, `${target} should not be served`);
    }
  });

  it('refuses a manifest entry that escapes the extension directory', async () => {
    // The manifest schema rejects `..` already, so this can only arrive from a
    // registry built another way; the route must not be the only thing standing
    // between a bad entry path and an arbitrary read.
    const res = await asUser(
      request(appFor(registryWithPanel({ entry: '../outside.mjs' }))).get(
        '/api/v1/ext/demo/ui/dashboard.mjs'
      )
    );

    assert.equal(res.status, 404);
  });

  it("gates the bundle behind the panel's declared permission", async () => {
    const registry = registryWithPanel({ permission: 'demo:view' });
    setExtensionPermissionDeclarations(() => [
      {
        extensionId: 'demo',
        permission: 'demo:view',
        key: 'view',
        name: 'View the dashboard',
        default: false,
        requiresCore: [],
      },
    ]);

    const friend = await getRepository(User).findOneOrFail({
      where: { email: 'friend@seerr.dev' },
    });

    // Ungranted: the bundle is source the user is not entitled to run, so it is
    // refused rather than served and gated only in the UI.
    assert.equal(
      (
        await asUser(
          request(appFor(registry)).get('/api/v1/ext/demo/ui/dashboard.mjs'),
          friend.id
        )
      ).status,
      403
    );

    await grantExtensionPermission(friend.id, 'demo:view');

    assert.equal(
      (
        await asUser(
          request(appFor(registry)).get('/api/v1/ext/demo/ui/dashboard.mjs'),
          friend.id
        )
      ).status,
      200
    );
  });

  it('404s when the declared entry file is missing', async () => {
    const res = await asUser(
      request(appFor(registryWithPanel({ entry: 'dist/gone.mjs' }))).get(
        '/api/v1/ext/demo/ui/dashboard.mjs'
      )
    );

    assert.equal(res.status, 404);
  });
});
