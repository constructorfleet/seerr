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

import type { ExtensionFetcher } from '@server/lib/extensions/install';
import { MANIFEST_FILENAME } from '@server/lib/extensions/install';
import { ExtensionRegistry } from '@server/lib/extensions/registry';
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
import request from 'supertest';

setupTestDb();

const API_KEY = 'settings-extensions-test-api-key';

let app: Express;
let priorApiKey: string;
let directory: string;

before(() => {
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
});

after(() => {
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
    const res = await asAdmin(request(app).get('/api/v1/settings/extensions'));

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

    const res = await asAdmin(request(app).get('/api/v1/settings/extensions'));

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

    const res = await asAdmin(request(app).get('/api/v1/settings/extensions'));

    assert.strictEqual(res.body[0].enabled, false);
  });

  it('answers 403 to a non-admin', async () => {
    const res = await asUser(request(app).get('/api/v1/settings/extensions'));

    assert.strictEqual(res.status, 403);
  });
});

describe('POST /settings/extensions', () => {
  it('installs from a source and reports what it installed', async () => {
    const res = await asAdmin(
      request(app).post('/api/v1/settings/extensions').send({ source: 'demo' })
    );

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.id, 'demo');
    assert.strictEqual(res.body.version, '1.0.0');
    assert.deepStrictEqual(await installed(), ['demo']);
  });

  it('reports a rejected install as a 400 with the reason', async () => {
    const res = await asAdmin(
      request(app)
        .post('/api/v1/settings/extensions')
        .send({ source: 'broken' })
    );

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, new RegExp(MANIFEST_FILENAME));
    assert.deepStrictEqual(await installed(), []);
  });

  it('requires a source', async () => {
    const res = await asAdmin(
      request(app).post('/api/v1/settings/extensions').send({})
    );

    assert.strictEqual(res.status, 400);
  });

  it('says that a restart is needed', async () => {
    // Nothing is loaded by installing: entities have to be injected before
    // `dataSource.initialize()`, so an extension cannot begin running in a
    // process that started without it.
    const res = await asAdmin(
      request(app).post('/api/v1/settings/extensions').send({ source: 'demo' })
    );

    assert.strictEqual(res.body.restartRequired, true);
  });

  it('answers 403 to a non-admin', async () => {
    const res = await asUser(
      request(app).post('/api/v1/settings/extensions').send({ source: 'demo' })
    );

    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(await installed(), []);
  });
});

describe('DELETE /settings/extensions/{extensionId}', () => {
  async function install(source: string): Promise<void> {
    await asAdmin(
      request(app).post('/api/v1/settings/extensions').send({ source })
    );
  }

  it('uninstalls an installed extension', async () => {
    await install('demo');

    const res = await asAdmin(
      request(app).delete('/api/v1/settings/extensions/demo')
    );

    assert.strictEqual(res.status, 204);
    assert.deepStrictEqual(await installed(), []);
  });

  it('keeps the permission rows unless asked to purge', async () => {
    await install('demo');

    const res = await asAdmin(
      request(app).delete('/api/v1/settings/extensions/demo')
    );

    assert.strictEqual(res.status, 204);
  });

  it('forgets the enable setting, so a reinstall is enabled', async () => {
    await install('demo');
    await asAdmin(
      request(app).post('/api/v1/settings/extensions/demo/disable')
    );

    await asAdmin(request(app).delete('/api/v1/settings/extensions/demo'));

    assert.strictEqual('demo' in getSettings().extensions, false);
  });

  it('purges data when asked', async () => {
    await install('demo');

    const res = await asAdmin(
      request(app).delete('/api/v1/settings/extensions/demo?purgeData=true')
    );

    assert.strictEqual(res.status, 204);
  });

  it('answers 404 for an extension that is not installed', async () => {
    const res = await asAdmin(
      request(app).delete('/api/v1/settings/extensions/absent')
    );

    assert.strictEqual(res.status, 404);
  });

  it('answers 400 for an id that is not a valid extension id', async () => {
    const res = await asAdmin(
      request(app).delete('/api/v1/settings/extensions/Not_An_Id')
    );

    assert.strictEqual(res.status, 400);
  });

  it('answers 403 to a non-admin', async () => {
    await install('demo');

    const res = await asUser(
      request(app).delete('/api/v1/settings/extensions/demo')
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
});

describe('POST /settings/extensions/{extensionId}/enable and /disable', () => {
  beforeEach(async () => {
    await asAdmin(
      request(app).post('/api/v1/settings/extensions').send({ source: 'demo' })
    );
  });

  it('persists a disable', async () => {
    const res = await asAdmin(
      request(app).post('/api/v1/settings/extensions/demo/disable')
    );

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(getSettings().extensions.demo, { enabled: false });
  });

  it('persists an enable', async () => {
    await asAdmin(
      request(app).post('/api/v1/settings/extensions/demo/disable')
    );

    const res = await asAdmin(
      request(app).post('/api/v1/settings/extensions/demo/enable')
    );

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(getSettings().extensions.demo, { enabled: true });
  });

  it('says that a restart is needed', async () => {
    const res = await asAdmin(
      request(app).post('/api/v1/settings/extensions/demo/disable')
    );

    // Same reason as install: what is loaded was decided before the DataSource
    // was initialized.
    assert.strictEqual(res.body.restartRequired, true);
  });

  it('answers 404 for an extension that is not installed', async () => {
    const res = await asAdmin(
      request(app).post('/api/v1/settings/extensions/absent/disable')
    );

    assert.strictEqual(res.status, 404);
  });

  it('answers 403 to a non-admin', async () => {
    const res = await asUser(
      request(app).post('/api/v1/settings/extensions/demo/disable')
    );

    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(getSettings().extensions, {});
  });
});
