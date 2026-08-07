/**
 * The admin endpoints for listing, installing, uninstalling, enabling and
 * disabling extensions.
 *
 * These are *fixed core* routes under `/api/v1/settings/extensions`, so they go
 * through the OpenAPI validator like any other core route and are documented in
 * `seerr-api.yml`. The whole `/settings` subtree is mounted behind
 * `isAuthenticated(Permission.ADMIN)`, which is where the permission gate comes
 * from — the "answers 403 to a non-admin" test below is what pins that.
 *
 * Install is injected: `setExtensionInstaller` replaces the fetch step, so nothing
 * here needs a registry, a git remote, or a network.
 *
 * Requests go to a **persistent** `server` rather than to `app` directly. Handing
 * supertest an app makes it start an ephemeral server, serve the one request, and
 * close it again; a small fraction of those cycles lose a race and the client
 * gets `ECONNRESET` instead of a response, which then fails whichever assertion
 * came next — reported as a puzzling 404 from an unrelated route rather than as a
 * connection error. This file makes 83 requests per run, so it hit that often
 * enough to fail roughly one run in six. Binding once took it to one in 75.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from 'node:test';

import { getRepository } from '@server/datasource';
import { ExtensionPermission } from '@server/entity/ExtensionPermission';
import type { ExtensionFetcher } from '@server/lib/extensions/install';
import { MANIFEST_FILENAME } from '@server/lib/extensions/install';
import type { ExtensionManifestSetting } from '@server/lib/extensions/manifest';
import { setExtensionPermissionDeclarations } from '@server/lib/extensions/permissions';
import { ExtensionRegistry } from '@server/lib/extensions/registry';
import { setExtensionSettingDeclarations } from '@server/lib/extensions/settingValues';
import { getSettings } from '@server/lib/settings';
import routes from '@server/routes';
import {
  setExtensionInstallDirectory,
  setExtensionInstaller,
  setExtensionRegistry,
} from '@server/routes/settings/extensions';
import { setupTestDb } from '@server/test/db';
import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import type { Server } from 'http';
import request from 'supertest';

setupTestDb();

const API_KEY = 'settings-extensions-test-api-key';

let app: Express;
let server: Server;
let priorApiKey: string;
let directory: string;

before(async () => {
  priorApiKey = getSettings().main.apiKey;
  getSettings().main.apiKey = API_KEY;

  app = express();
  app.use(express.json());
  app.use('/api/v1', routes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: Request,
      res: Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );

  server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  getSettings().main.apiKey = priorApiKey;
  setExtensionInstallDirectory(undefined);
  setExtensionInstaller(undefined);
  setExtensionRegistry(undefined);
});

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'seerr-ext-routes-'));
  setExtensionInstallDirectory(directory);
  setExtensionInstaller(fetcherFor);
  setExtensionRegistry(new ExtensionRegistry());
  getSettings().extensions = {};
  mock.method(getSettings(), 'save', async () => undefined);
});

afterEach(async () => {
  mock.restoreAll();
  getSettings().extensions = {};
  // Both resolvers are process-wide singletons, so a test that injected
  // declarations would otherwise leak them into every test after it.
  setExtensionSettingDeclarations(() => []);
  setExtensionPermissionDeclarations(() => []);
  await getRepository(ExtensionPermission).clear();
  await fs.rm(directory, { recursive: true, force: true });
});

/**
 * Stands in for npm and git. The `source` a request supplies is read as the id to
 * fabricate, and a source of `broken` produces a package with no manifest.
 */
function fetcherFor(source: string): ExtensionFetcher {
  return async (staging: string) => {
    if (source === 'broken') {
      await fs.writeFile(path.join(staging, 'server.js'), '');
      return;
    }

    await fs.writeFile(
      path.join(staging, MANIFEST_FILENAME),
      JSON.stringify({
        id: source,
        name: `Extension ${source}`,
        version: '1.0.0',
        apiVersion: '^1.0.0',
        server: 'server.js',
      })
    );
    await fs.writeFile(path.join(staging, 'server.js'), '');
  };
}

/** The per-extension route prefix for `id`. */
function base(id: string): string {
  return `/api/v1/settings/extensions/${id}`;
}

function asAdmin(pending: request.Test): request.Test {
  return pending.set('X-API-Key', API_KEY).set('X-API-User', '1');
}

/** `friend@seerr.dev`, seeded with permissions 32 — no ADMIN bit. */
function asUser(pending: request.Test): request.Test {
  return pending.set('X-API-Key', API_KEY).set('X-API-User', '2');
}

async function installed(): Promise<string[]> {
  return (await fs.readdir(directory)).sort();
}

describe('GET /settings/extensions', () => {
  it('lists nothing when nothing is installed', async () => {
    const res = await asAdmin(
      request(server).get('/api/v1/settings/extensions')
    );

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, []);
  });

  it('reports health and the persisted enable state together', async () => {
    // The two come from different places — the registry knows what loaded, the
    // settings file knows what the operator asked for — and an admin UI needs
    // both to distinguish "off" from "broken".
    const registry = new ExtensionRegistry();
    registry.add({
      id: 'demo',
      directory: path.join(directory, 'demo'),
      status: 'active',
      manifest: {
        id: 'demo',
        name: 'Demo',
        version: '1.2.3',
        apiVersion: '^1.0.0',
        server: 'server.js',
      },
      entities: [],
      migrations: [],
    });
    setExtensionRegistry(registry);

    const res = await asAdmin(
      request(server).get('/api/v1/settings/extensions')
    );

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, [
      {
        id: 'demo',
        name: 'Demo',
        version: '1.2.3',
        status: 'active',
        enabled: true,
      },
    ]);
  });

  /**
   * The settings pages drew a hardcoded puzzle piece while the sidebar drew the
   * manifest's icon, so one extension had two identities. The icon an extension
   * already declares for its sidebar link is the one it means, so it is reported
   * here too rather than invented.
   */
  it('reports the icon an extension declared for its panel', async () => {
    const registry = new ExtensionRegistry();
    registry.add({
      id: 'demo',
      directory: path.join(directory, 'demo'),
      status: 'active',
      manifest: {
        id: 'demo',
        name: 'Demo',
        version: '1.2.3',
        apiVersion: '^1.0.0',
        server: 'server.js',
        provides: {
          panels: [
            {
              slug: 'main',
              title: 'Main',
              entry: 'panel.js',
              sidebar: { icon: 'TrashIcon', order: 60 },
            },
          ],
        },
      },
      entities: [],
      migrations: [],
    });
    setExtensionRegistry(registry);

    const res = await asAdmin(
      request(server).get('/api/v1/settings/extensions')
    );

    assert.strictEqual(res.body[0].icon, 'TrashIcon');
  });

  /**
   * Lowest `order` wins, which is the one the sidebar lists first. An extension
   * with several panels has no single icon otherwise, and picking whichever came
   * first in the manifest array would make the settings page disagree with the
   * sidebar for no reason a reader could see.
   */
  it('picks the first-ordered icon when several panels declare one', async () => {
    const registry = new ExtensionRegistry();
    registry.add({
      id: 'demo',
      directory: path.join(directory, 'demo'),
      status: 'active',
      manifest: {
        id: 'demo',
        name: 'Demo',
        version: '1.2.3',
        apiVersion: '^1.0.0',
        server: 'server.js',
        provides: {
          panels: [
            {
              slug: 'second',
              title: 'Second',
              entry: 'b.js',
              sidebar: { icon: 'FilmIcon', order: 90 },
            },
            {
              slug: 'first',
              title: 'First',
              entry: 'a.js',
              sidebar: { icon: 'TrashIcon', order: 10 },
            },
          ],
        },
      },
      entities: [],
      migrations: [],
    });
    setExtensionRegistry(registry);

    const res = await asAdmin(
      request(server).get('/api/v1/settings/extensions')
    );

    assert.strictEqual(res.body[0].icon, 'TrashIcon');
  });

  it('omits the icon when no panel declares one', async () => {
    const registry = new ExtensionRegistry();
    registry.add({
      id: 'demo',
      directory: path.join(directory, 'demo'),
      status: 'active',
      manifest: {
        id: 'demo',
        name: 'Demo',
        version: '1.2.3',
        apiVersion: '^1.0.0',
        server: 'server.js',
      },
      entities: [],
      migrations: [],
    });
    setExtensionRegistry(registry);

    const res = await asAdmin(
      request(server).get('/api/v1/settings/extensions')
    );

    assert.ok(!('icon' in res.body[0]));
  });

  it('reports a disabled extension as not enabled', async () => {
    const registry = new ExtensionRegistry();
    registry.add({
      id: 'demo',
      directory: path.join(directory, 'demo'),
      status: 'disabled',
      entities: [],
      migrations: [],
    });
    setExtensionRegistry(registry);
    getSettings().extensions = { demo: { enabled: false } };

    const res = await asAdmin(
      request(server).get('/api/v1/settings/extensions')
    );

    assert.strictEqual(res.body[0].enabled, false);
  });

  it('answers 403 to a non-admin', async () => {
    const res = await asUser(
      request(server).get('/api/v1/settings/extensions')
    );

    assert.strictEqual(res.status, 403);
  });
});

describe('POST /settings/extensions', () => {
  it('installs from a source and reports what it installed', async () => {
    const res = await asAdmin(
      request(server)
        .post('/api/v1/settings/extensions')
        .send({ source: 'demo' })
    );

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.id, 'demo');
    assert.strictEqual(res.body.version, '1.0.0');
    assert.deepStrictEqual(await installed(), ['demo']);
  });

  it('reports a rejected install as a 400 with the reason', async () => {
    const res = await asAdmin(
      request(server)
        .post('/api/v1/settings/extensions')
        .send({ source: 'broken' })
    );

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, new RegExp(MANIFEST_FILENAME));
    assert.deepStrictEqual(await installed(), []);
  });

  it('requires a source', async () => {
    const res = await asAdmin(
      request(server).post('/api/v1/settings/extensions').send({})
    );

    assert.strictEqual(res.status, 400);
  });

  it('says that a restart is needed', async () => {
    // Nothing is loaded by installing: entities have to be injected before
    // `dataSource.initialize()`, so an extension cannot begin running in a
    // process that started without it.
    const res = await asAdmin(
      request(server)
        .post('/api/v1/settings/extensions')
        .send({ source: 'demo' })
    );

    assert.strictEqual(res.body.restartRequired, true);
  });

  it('answers 403 to a non-admin', async () => {
    const res = await asUser(
      request(server)
        .post('/api/v1/settings/extensions')
        .send({ source: 'demo' })
    );

    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(await installed(), []);
  });
});

describe('DELETE /settings/extensions/{extensionId}', () => {
  async function install(source: string): Promise<void> {
    const res = await asAdmin(
      request(server).post('/api/v1/settings/extensions').send({ source })
    );

    assert.strictEqual(
      res.status,
      201,
      `installing "${source}" failed: ${res.status} ${JSON.stringify(res.body)}`
    );
  }

  it('uninstalls an installed extension', async () => {
    await install('demo');

    const res = await asAdmin(
      request(server).delete('/api/v1/settings/extensions/demo')
    );

    assert.strictEqual(res.status, 204);
    assert.deepStrictEqual(await installed(), []);
  });

  it('keeps the permission rows unless asked to purge', async () => {
    await install('demo');

    const res = await asAdmin(
      request(server).delete('/api/v1/settings/extensions/demo')
    );

    assert.strictEqual(res.status, 204);
  });

  it('forgets the enable setting, so a reinstall is enabled', async () => {
    await install('demo');
    await asAdmin(
      request(server).post('/api/v1/settings/extensions/demo/disable')
    );

    await asAdmin(request(server).delete('/api/v1/settings/extensions/demo'));

    assert.strictEqual('demo' in getSettings().extensions, false);
  });

  it('purges data when asked', async () => {
    await install('demo');

    const res = await asAdmin(
      request(server).delete('/api/v1/settings/extensions/demo?purgeData=true')
    );

    assert.strictEqual(res.status, 204);
  });

  it('answers 404 for an extension that is not installed', async () => {
    const res = await asAdmin(
      request(server).delete('/api/v1/settings/extensions/absent')
    );

    assert.strictEqual(res.status, 404);
  });

  it('answers 400 for an id that is not a valid extension id', async () => {
    const res = await asAdmin(
      request(server).delete('/api/v1/settings/extensions/Not_An_Id')
    );

    assert.strictEqual(res.status, 400);
  });

  /**
   * Only `DELETE` used to validate the id; every other per-extension route
   * relied on a `path.basename` check, which is not a containment check — the id
   * then reaches `settings.extensions[id]` keys and the `ext_<id>_` table and
   * permission prefixes.
   */
  it('answers 400 for a malformed id on every per-extension route', async () => {
    const id = 'Not_An_Id';

    // Sequential rather than `Promise.all`: these routes read and write the
    // shared install directory and `settings.json`, so running them concurrently
    // races with the other tests in this file.
    const requests: [string, () => request.Test][] = [
      ['POST enable', () => request(server).post(`${base(id)}/enable`)],
      ['POST disable', () => request(server).post(`${base(id)}/disable`)],
      ['GET settings', () => request(server).get(`${base(id)}/settings`)],
      [
        'POST settings',
        () =>
          request(server)
            .post(`${base(id)}/settings`)
            .send({ values: {} }),
      ],
      ['DELETE settings', () => request(server).delete(`${base(id)}/settings`)],
      ['GET permissions', () => request(server).get(`${base(id)}/permissions`)],
      [
        'POST permission holders',
        () =>
          request(server)
            .post(`${base(id)}/permissions/view`)
            .send({ userIds: [], granted: true }),
      ],
      [
        'POST permission default',
        () =>
          request(server)
            .post(`${base(id)}/permissions/view/default`)
            .send({ default: true }),
      ],
      [
        'DELETE permission defaults',
        () => request(server).delete(`${base(id)}/permissions/defaults`),
      ],
    ];

    for (const [label, send] of requests) {
      const res = await asAdmin(send());

      assert.strictEqual(res.status, 400, `expected 400 for ${label}`);
    }
  });

  it('answers 403 to a non-admin', async () => {
    await install('demo');

    const res = await asUser(
      request(server).delete('/api/v1/settings/extensions/demo')
    );

    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(await installed(), ['demo']);
  });
});

/**
 * Unlike an extension's own routes, these are documented in `seerr-api.yml` and so
 * sit *behind* the OpenAPI validator, which rejects any path it does not know. A
 * spec that has drifted from the implementation therefore breaks these endpoints
 * outright rather than subtly, which is what this pins.
 */
describe('seerr-api.yml documents these routes', () => {
  function validatedApp(): Express {
    const validated = express();
    validated.use(express.json());
    validated.use(
      OpenApiValidator.middleware({
        apiSpec: path.join(__dirname, '../../seerr-api.yml'),
        validateRequests: true,
      })
    );
    validated.use('/api/v1', routes);
    validated.use(
      (
        err: { status?: number; message?: string },
        _req: Request,
        res: Response,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _next: NextFunction
      ) => {
        res
          .status(err.status ?? 500)
          .json({ status: err.status ?? 500, message: err.message });
      }
    );

    return validated;
  }

  it('validates the list endpoint', async () => {
    const res = await asAdmin(
      request(validatedApp()).get('/api/v1/settings/extensions')
    );

    assert.strictEqual(res.status, 200);
  });

  it('validates the install endpoint', async () => {
    const res = await asAdmin(
      request(validatedApp())
        .post('/api/v1/settings/extensions')
        .send({ source: 'demo' })
    );

    assert.strictEqual(res.status, 201);
  });

  it('rejects an install body with no source before the handler sees it', async () => {
    const res = await asAdmin(
      request(validatedApp()).post('/api/v1/settings/extensions').send({})
    );

    assert.strictEqual(res.status, 400);
  });

  it('validates the uninstall endpoint, purgeData included', async () => {
    await asAdmin(
      request(validatedApp())
        .post('/api/v1/settings/extensions')
        .send({ source: 'demo' })
    );

    const res = await asAdmin(
      request(validatedApp()).delete(
        '/api/v1/settings/extensions/demo?purgeData=true'
      )
    );

    assert.strictEqual(res.status, 204);
  });

  it('validates the enable and disable endpoints', async () => {
    await asAdmin(
      request(validatedApp())
        .post('/api/v1/settings/extensions')
        .send({ source: 'demo' })
    );

    for (const action of ['disable', 'enable']) {
      const res = await asAdmin(
        request(validatedApp()).post(
          `/api/v1/settings/extensions/demo/${action}`
        )
      );

      assert.strictEqual(res.status, 200, `${action} was rejected`);
    }
  });

  it('validates the declared-settings endpoints', async () => {
    await install('demo');
    declare([{ key: 'endpoint', type: 'string', name: 'Endpoint' }]);

    assert.strictEqual(
      (
        await asAdmin(
          request(validatedApp()).get(
            '/api/v1/settings/extensions/demo/settings'
          )
        )
      ).status,
      200
    );
    assert.strictEqual(
      (
        await asAdmin(
          request(validatedApp())
            .post('/api/v1/settings/extensions/demo/settings')
            .send({ values: { endpoint: 'https://plex.tv' } })
        )
      ).status,
      200
    );
    assert.strictEqual(
      (
        await asAdmin(
          request(validatedApp()).delete(
            '/api/v1/settings/extensions/demo/settings/endpoint'
          )
        )
      ).status,
      204
    );
    assert.strictEqual(
      (
        await asAdmin(
          request(validatedApp()).delete(
            '/api/v1/settings/extensions/demo/settings'
          )
        )
      ).status,
      204
    );
  });

  it('validates the permission matrix endpoints', async () => {
    await install('demo');
    declarePermissions([{ key: 'view_own', name: 'View Own' }]);

    assert.strictEqual(
      (
        await asAdmin(
          request(validatedApp()).get(
            '/api/v1/settings/extensions/demo/permissions?take=10&skip=0'
          )
        )
      ).status,
      200
    );
    assert.strictEqual(
      (
        await asAdmin(
          request(validatedApp())
            .post('/api/v1/settings/extensions/demo/permissions/view_own')
            .send({ userIds: [2], granted: true })
        )
      ).status,
      200
    );
    assert.strictEqual(
      (
        await asAdmin(
          request(validatedApp())
            .post(
              '/api/v1/settings/extensions/demo/permissions/view_own/default'
            )
            .send({ default: true })
        )
      ).status,
      200
    );
    assert.strictEqual(
      (
        await asAdmin(
          request(validatedApp()).delete(
            '/api/v1/settings/extensions/demo/permissions/defaults'
          )
        )
      ).status,
      204
    );
  });
});

/**
 * Installs `id` through the real install route, so the on-disk state the
 * `isInstalled` probe reads is genuinely there — every endpoint below 404s without
 * it.
 */
async function install(id: string): Promise<void> {
  // Asserted rather than fire-and-forget: this is setup for almost every test
  // below, and an install that quietly failed surfaced much later as a puzzling
  // 404 from whatever route the test was actually about.
  const res = await asAdmin(
    request(server).post('/api/v1/settings/extensions').send({ source: id })
  );

  assert.strictEqual(
    res.status,
    201,
    `installing "${id}" failed: ${res.status} ${JSON.stringify(res.body)}`
  );
}

/**
 * Injects the settings `demo` declares. Injected rather than driven from a
 * registry because the manifest the fake fetcher writes has no `provides` block,
 * and what these tests are about is the route's behaviour given a declaration —
 * not how the declaration was discovered.
 */
function declare(settings: ExtensionManifestSetting[]): void {
  setExtensionSettingDeclarations((id) => (id === 'demo' ? settings : []));
}

/** The same, for permissions. */
function declarePermissions(
  permissions: { key: string; name: string; default?: boolean }[]
): void {
  setExtensionPermissionDeclarations(() =>
    permissions.map((permission) => ({
      extensionId: 'demo',
      key: permission.key,
      permission: `demo:${permission.key}`,
      name: permission.name,
      default: permission.default ?? false,
      requiresCore: [],
    }))
  );
}

describe('GET /settings/extensions/{extensionId}/settings', () => {
  beforeEach(async () => {
    await install('demo');
  });

  it('returns the declared schema and the current values', async () => {
    declare([
      { key: 'endpoint', type: 'string', name: 'Endpoint' },
      { key: 'batch_size', type: 'number', name: 'Batch Size', default: 25 },
    ]);

    const res = await asAdmin(
      request(server).get('/api/v1/settings/extensions/demo/settings')
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.settings.length, 2);
    // The declared default is applied on read, so the form renders 25 for a key
    // the operator has never saved.
    assert.deepStrictEqual(res.body.values, { batch_size: 25 });
  });

  it('never sends a secret to the browser', async () => {
    declare([{ key: 'api_token', type: 'secret', name: 'API Token' }]);
    await asAdmin(
      request(server)
        .post('/api/v1/settings/extensions/demo/settings')
        .send({ values: { api_token: 'hunter2' } })
    );

    const res = await asAdmin(
      request(server).get('/api/v1/settings/extensions/demo/settings')
    );

    assert.strictEqual(
      JSON.stringify(res.body).includes('hunter2'),
      false,
      'the credential reached the client'
    );
    assert.strictEqual(res.body.values.api_token, '********');
  });

  it('reports an empty schema for an extension that declares nothing', async () => {
    const res = await asAdmin(
      request(server).get('/api/v1/settings/extensions/demo/settings')
    );

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.settings, []);
  });

  it('answers 404 for an extension that is not installed', async () => {
    const res = await asAdmin(
      request(server).get('/api/v1/settings/extensions/absent/settings')
    );

    assert.strictEqual(res.status, 404);
  });

  it('answers 403 to a non-admin', async () => {
    const res = await asUser(
      request(server).get('/api/v1/settings/extensions/demo/settings')
    );

    assert.strictEqual(res.status, 403);
  });
});

describe('POST /settings/extensions/{extensionId}/settings', () => {
  beforeEach(async () => {
    await install('demo');
    declare([
      { key: 'endpoint', type: 'string', name: 'Endpoint' },
      {
        key: 'batch_size',
        type: 'number',
        name: 'Batch Size',
        default: 25,
        min: 1,
        max: 100,
      },
      { key: 'api_token', type: 'secret', name: 'API Token' },
    ]);
  });

  function save(values: unknown): request.Test {
    return asAdmin(
      request(server)
        .post('/api/v1/settings/extensions/demo/settings')
        .send({ values })
    );
  }

  it('persists what it was given and reports the stored state back', async () => {
    const res = await save({ endpoint: 'https://plex.tv' });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.values, {
      endpoint: 'https://plex.tv',
      batch_size: 25,
    });
    assert.deepStrictEqual(getSettings().extensions.demo?.values, {
      endpoint: 'https://plex.tv',
    });
  });

  it('leaves a key it was not given alone', async () => {
    await save({ endpoint: 'https://plex.tv' });
    await save({ batch_size: 5 });

    assert.deepStrictEqual(getSettings().extensions.demo?.values, {
      endpoint: 'https://plex.tv',
      batch_size: 5,
    });
  });

  /**
   * The property that matters most here. The client is never given the real
   * secret, so it renders the sentinel and submits it back on every save — a
   * route that read it as a new value would overwrite the credential with
   * asterisks the first time an operator edited an unrelated field.
   */
  it('does not overwrite a secret with the redaction sentinel', async () => {
    await save({ api_token: 'hunter2' });
    await save({ api_token: '********', endpoint: 'https://plex.tv' });

    assert.strictEqual(
      getSettings().extensions.demo?.values?.api_token,
      'hunter2'
    );
    assert.strictEqual(
      getSettings().extensions.demo?.values?.endpoint,
      'https://plex.tv'
    );
  });

  it('accepts a genuine replacement secret', async () => {
    await save({ api_token: 'hunter2' });
    await save({ api_token: 'correct-horse' });

    assert.strictEqual(
      getSettings().extensions.demo?.values?.api_token,
      'correct-horse'
    );
  });

  it('rejects a value of the wrong type, naming the field', async () => {
    const res = await save({ batch_size: 'many' });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /batch_size/);
  });

  it('rejects a number outside its declared bounds', async () => {
    assert.strictEqual((await save({ batch_size: 0 })).status, 400);
    assert.strictEqual((await save({ batch_size: 101 })).status, 400);
  });

  it('rejects a key the extension does not declare', async () => {
    const res = await save({ nonsense: 1 });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /nonsense/);
  });

  it('persists nothing when any key in the submission is invalid', async () => {
    const res = await save({ endpoint: 'https://plex.tv', batch_size: 0 });

    assert.strictEqual(res.status, 400);
    // Validated as a whole, so a form with one bad field changes nothing rather
    // than applying half of itself.
    assert.strictEqual(getSettings().extensions.demo?.values, undefined);
  });

  it('requires a values object', async () => {
    const res = await asAdmin(
      request(server).post('/api/v1/settings/extensions/demo/settings').send({})
    );

    assert.strictEqual(res.status, 400);
  });

  it('answers 403 to a non-admin, and writes nothing', async () => {
    const res = await asUser(
      request(server)
        .post('/api/v1/settings/extensions/demo/settings')
        .send({ values: { endpoint: 'https://evil.example' } })
    );

    assert.strictEqual(res.status, 403);
    assert.strictEqual(getSettings().extensions.demo?.values, undefined);
  });
});

describe('DELETE /settings/extensions/{extensionId}/settings', () => {
  beforeEach(async () => {
    await install('demo');
    declare([
      { key: 'endpoint', type: 'string', name: 'Endpoint' },
      { key: 'api_token', type: 'secret', name: 'API Token' },
    ]);
    await asAdmin(
      request(server)
        .post('/api/v1/settings/extensions/demo/settings')
        .send({ values: { endpoint: 'https://plex.tv', api_token: 'hunter2' } })
    );
  });

  it('clears one key, which is the only way to unset a secret', async () => {
    const res = await asAdmin(
      request(server).delete(
        '/api/v1/settings/extensions/demo/settings/api_token'
      )
    );

    assert.strictEqual(res.status, 204);
    assert.deepStrictEqual(getSettings().extensions.demo?.values, {
      endpoint: 'https://plex.tv',
    });
  });

  it('clears every key when given no key', async () => {
    const res = await asAdmin(
      request(server).delete('/api/v1/settings/extensions/demo/settings')
    );

    assert.strictEqual(res.status, 204);
    assert.strictEqual(getSettings().extensions.demo?.values, undefined);
    // Resetting the configuration is not the same as switching the extension
    // off, so the enable state survives.
    assert.strictEqual(getSettings().extensions.demo?.enabled, true);
  });

  it('rejects a key the extension does not declare', async () => {
    const res = await asAdmin(
      request(server).delete(
        '/api/v1/settings/extensions/demo/settings/nonsense'
      )
    );

    assert.strictEqual(res.status, 400);
  });

  it('answers 403 to a non-admin, and clears nothing', async () => {
    const res = await asUser(
      request(server).delete('/api/v1/settings/extensions/demo/settings')
    );

    assert.strictEqual(res.status, 403);
    assert.ok(getSettings().extensions.demo?.values);
  });
});

describe('GET /settings/extensions/{extensionId}/permissions', () => {
  beforeEach(async () => {
    await install('demo');
    declarePermissions([{ key: 'view_own', name: 'View Own' }]);
  });

  it('reports each declared permission with who holds it', async () => {
    const res = await asAdmin(
      request(server).get('/api/v1/settings/extensions/demo/permissions')
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.permissions.length, 1);
    assert.strictEqual(res.body.permissions[0].permission, 'demo:view_own');

    // The seeded admin is a candidate without a grant row, because the ADMIN
    // short-circuit means the permission genuinely applies to them.
    const admin = res.body.permissions[0].holders.find(
      (holder: { email: string }) => holder.email === 'admin@seerr.dev'
    );

    assert.strictEqual(admin.granted, false);
    assert.strictEqual(admin.effective, true);
    assert.strictEqual(admin.effectiveByAdmin, true);
  });

  it('reports an empty matrix for an extension that declares nothing', async () => {
    setExtensionPermissionDeclarations(() => []);

    const res = await asAdmin(
      request(server).get('/api/v1/settings/extensions/demo/permissions')
    );

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.permissions, []);
  });

  it('answers 403 to a non-admin', async () => {
    const res = await asUser(
      request(server).get('/api/v1/settings/extensions/demo/permissions')
    );

    assert.strictEqual(res.status, 403);
  });
});

describe('POST /settings/extensions/{extensionId}/permissions/{key}', () => {
  beforeEach(async () => {
    await install('demo');
    declarePermissions([{ key: 'view_own', name: 'View Own' }]);
  });

  function grant(userIds: unknown, granted: unknown): request.Test {
    return asAdmin(
      request(server)
        .post('/api/v1/settings/extensions/demo/permissions/view_own')
        .send({ userIds, granted })
    );
  }

  function holderFor(body: {
    permissions: { holders: { id: number; granted: boolean }[] }[];
  }): { granted: boolean } | undefined {
    return body.permissions[0].holders.find((holder) => holder.id === 2);
  }

  it('grants to the users it was given, and reports the refreshed matrix', async () => {
    const res = await grant([2], true);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(holderFor(res.body)?.granted, true);
  });

  it('is idempotent', async () => {
    await grant([2], true);
    const res = await grant([2], true);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(holderFor(res.body)?.granted, true);
  });

  it('revokes', async () => {
    await grant([2], true);
    const res = await grant([2], false);

    assert.strictEqual(res.status, 200);
    // The user leaves the candidate set entirely once no row backs them, which
    // is the matrix reporting only who is relevant rather than every user.
    assert.strictEqual(holderFor(res.body)?.granted ?? false, false);
  });

  it('ignores a user id that no longer exists', async () => {
    // A stale row in an admin UI must not fail a bulk write that is otherwise
    // entirely valid.
    const res = await grant([2, 9999], true);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(holderFor(res.body)?.granted, true);
  });

  it('rejects a permission the extension does not declare', async () => {
    const res = await asAdmin(
      request(server)
        .post('/api/v1/settings/extensions/demo/permissions/nonsense')
        .send({ userIds: [2], granted: true })
    );

    assert.strictEqual(res.status, 400);
  });

  it('rejects a malformed body', async () => {
    assert.strictEqual((await grant('two', true)).status, 400);
    assert.strictEqual((await grant([2.5], true)).status, 400);
    assert.strictEqual((await grant([2], 'yes')).status, 400);
  });

  it('answers 403 to a non-admin, and grants nothing', async () => {
    const res = await asUser(
      request(server)
        .post('/api/v1/settings/extensions/demo/permissions/view_own')
        .send({ userIds: [2], granted: true })
    );

    assert.strictEqual(res.status, 403);

    const matrix = await asAdmin(
      request(server).get('/api/v1/settings/extensions/demo/permissions')
    );

    assert.strictEqual(holderFor(matrix.body)?.granted ?? false, false);
  });
});

describe('the permission defaults for new users', () => {
  beforeEach(async () => {
    await install('demo');
    declarePermissions([{ key: 'view_own', name: 'View Own', default: false }]);
  });

  it('records an override of the manifest flag', async () => {
    const res = await asAdmin(
      request(server)
        .post('/api/v1/settings/extensions/demo/permissions/view_own/default')
        .send({ default: true })
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.permissions[0].default, true);
    // Reported alongside, so the UI can show what is being overridden rather
    // than presenting the override as the extension author's intent.
    assert.strictEqual(res.body.permissions[0].manifestDefault, false);
    assert.strictEqual(res.body.permissions[0].operatorDefault, true);
  });

  it('does not retroactively grant to existing users', async () => {
    await asAdmin(
      request(server)
        .post('/api/v1/settings/extensions/demo/permissions/view_own/default')
        .send({ default: true })
    );

    const res = await asAdmin(
      request(server).get('/api/v1/settings/extensions/demo/permissions')
    );

    // A default is policy for new accounts. Applying it backwards would undo an
    // operator's deliberate decision not to grant it.
    const friend = res.body.permissions[0].holders.find(
      (holder: { id: number }) => holder.id === 2
    );

    assert.strictEqual(friend?.granted ?? false, false);
  });

  it('drops every override, restoring the manifest defaults', async () => {
    await asAdmin(
      request(server)
        .post('/api/v1/settings/extensions/demo/permissions/view_own/default')
        .send({ default: true })
    );

    const res = await asAdmin(
      request(server).delete(
        '/api/v1/settings/extensions/demo/permissions/defaults'
      )
    );

    assert.strictEqual(res.status, 204);

    const matrix = await asAdmin(
      request(server).get('/api/v1/settings/extensions/demo/permissions')
    );

    assert.strictEqual(matrix.body.permissions[0].default, false);
    assert.strictEqual(matrix.body.permissions[0].operatorDefault, undefined);
  });

  it('leaves the enable state alone', async () => {
    await asAdmin(
      request(server)
        .post('/api/v1/settings/extensions/demo/permissions/view_own/default')
        .send({ default: true })
    );

    assert.strictEqual(getSettings().extensions.demo?.enabled, true);
  });

  it('rejects a non-boolean default', async () => {
    const res = await asAdmin(
      request(server)
        .post('/api/v1/settings/extensions/demo/permissions/view_own/default')
        .send({ default: 'yes' })
    );

    assert.strictEqual(res.status, 400);
  });

  it('answers 403 to a non-admin', async () => {
    const res = await asUser(
      request(server)
        .post('/api/v1/settings/extensions/demo/permissions/view_own/default')
        .send({ default: true })
    );

    assert.strictEqual(res.status, 403);
    assert.strictEqual(
      getSettings().extensions.demo?.permissionDefaults,
      undefined
    );
  });
});

describe('POST /settings/extensions/{extensionId}/enable and /disable', () => {
  beforeEach(async () => {
    await asAdmin(
      request(server)
        .post('/api/v1/settings/extensions')
        .send({ source: 'demo' })
    );
  });

  it('persists a disable', async () => {
    const res = await asAdmin(
      request(server).post('/api/v1/settings/extensions/demo/disable')
    );

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(getSettings().extensions.demo, { enabled: false });
  });

  it('persists an enable', async () => {
    await asAdmin(
      request(server).post('/api/v1/settings/extensions/demo/disable')
    );

    const res = await asAdmin(
      request(server).post('/api/v1/settings/extensions/demo/enable')
    );

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(getSettings().extensions.demo, { enabled: true });
  });

  it('says that a restart is needed', async () => {
    const res = await asAdmin(
      request(server).post('/api/v1/settings/extensions/demo/disable')
    );

    // Same reason as install: what is loaded was decided before the DataSource
    // was initialized.
    assert.strictEqual(res.body.restartRequired, true);
  });

  it('answers 404 for an extension that is not installed', async () => {
    const res = await asAdmin(
      request(server).post('/api/v1/settings/extensions/absent/disable')
    );

    assert.strictEqual(res.status, 404);
  });

  it('answers 403 to a non-admin', async () => {
    const res = await asUser(
      request(server).post('/api/v1/settings/extensions/demo/disable')
    );

    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(getSettings().extensions, {});
  });
});
