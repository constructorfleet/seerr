import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import {
  grantExtensionPermission,
  setExtensionPermissionDeclarations,
} from '@server/lib/extensions/permissions';
import type {
  ExtensionEntry,
  ExtensionRoute,
  ExtensionRouteMethod,
} from '@server/lib/extensions/registry';
import {
  ExtensionRegistrations,
  ExtensionRegistry,
} from '@server/lib/extensions/registry';
import type {
  ExtensionRouteHandler,
  ExtensionRouteOptions,
} from '@server/lib/extensions/types';
import { getSettings } from '@server/lib/settings';
import { createExtensionRouter } from '@server/routes/extension';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import request from 'supertest';
import { z } from 'zod';

setupTestDb();

const API_SPEC_PATH = path.join(__dirname, '../../seerr-api.yml');

/**
 * Authentication goes through the real `checkUser`, using its API-key path so a
 * test can act as any seeded user without a session round trip. What is being
 * tested is that the extension router populates `req.user` at all: it mounts
 * outside `server/routes`, so it does not inherit that router's `checkUser`.
 */
const API_KEY = 'extension-route-test-api-key';

let priorApiKey: string;

before(() => {
  priorApiKey = getSettings().main.apiKey;
  getSettings().main.apiKey = API_KEY;
});

after(() => {
  getSettings().main.apiKey = priorApiKey;
  setExtensionPermissionDeclarations(() => []);
});

interface FakeRoute {
  method?: ExtensionRouteMethod;
  path: string;
  options?: ExtensionRouteOptions;
  handler?: ExtensionRouteHandler;
}

interface FakeExtension {
  id: string;
  routes?: FakeRoute[];
  /** Quarantined during activation, so its registrations are discarded. */
  failed?: boolean;
}

const ok: ExtensionRouteHandler = (_req, res) => {
  res.status(200).json({ ok: true });
};

/**
 * A registry in the state activation leaves it in: entries added by discovery,
 * then either committed with their registrations or quarantined.
 */
function registryWith(extensions: FakeExtension[]): ExtensionRegistry {
  const registry = new ExtensionRegistry();

  for (const extension of extensions) {
    const entry: ExtensionEntry = {
      id: extension.id,
      directory: `/tmp/${extension.id}`,
      status: 'pending',
      entities: [],
      migrations: [],
    };
    registry.add(entry);

    if (extension.failed) {
      registry.fail(
        entry.id,
        new Error('activation exploded'),
        'running its entry point'
      );
      continue;
    }

    const registrations = new ExtensionRegistrations();
    registrations.routes.push(
      ...(extension.routes ?? []).map(
        (route): ExtensionRoute => ({
          extensionId: extension.id,
          method: route.method ?? 'get',
          path: route.path,
          options: route.options ?? {},
          handler: route.handler ?? ok,
        })
      )
    );
    registry.commit(entry, registrations);
  }

  return registry;
}

/** The mount order of `server/index.ts`, minus the OpenAPI validator. */
function createApp(extensions: FakeExtension[]): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/ext', createExtensionRouter(registryWith(extensions)));

  return app;
}

function asUser(pending: request.Test, userId: number): request.Test {
  return pending.set('X-API-Key', API_KEY).set('X-API-User', String(userId));
}

function getUser(email: string): Promise<User> {
  return getRepository(User).findOneOrFail({ where: { email } });
}

describe('extension router mounting', () => {
  it('responds to a route an extension registered', async () => {
    const app = createApp([{ id: 'demo', routes: [{ path: '/things' }] }]);

    const res = await request(app).get('/api/v1/ext/demo/things');

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ok: true });
  });

  it('mounts a path the extension declared without a leading slash', async () => {
    const app = createApp([{ id: 'demo', routes: [{ path: 'things' }] }]);

    assert.strictEqual(
      (await request(app).get('/api/v1/ext/demo/things')).status,
      200
    );
  });

  it('mounts the extension root at its namespace', async () => {
    const app = createApp([{ id: 'demo', routes: [{ path: '/' }] }]);

    assert.strictEqual(
      (await request(app).get('/api/v1/ext/demo')).status,
      200
    );
  });

  it('mounts every http method the sdk offers', async () => {
    const app = createApp([
      {
        id: 'demo',
        routes: [
          { method: 'get', path: '/thing' },
          { method: 'post', path: '/thing' },
          { method: 'put', path: '/thing' },
          { method: 'delete', path: '/thing' },
        ],
      },
    ]);

    for (const method of ['get', 'post', 'put', 'delete'] as const) {
      assert.strictEqual(
        (await request(app)[method]('/api/v1/ext/demo/thing')).status,
        200,
        `expected ${method} to be mounted`
      );
    }
  });

  it('passes route parameters through to the handler', async () => {
    const app = createApp([
      {
        id: 'demo',
        routes: [
          {
            path: '/things/:thingId',
            handler: (req, res) => {
              res.status(200).json({ thingId: req.params.thingId });
            },
          },
        ],
      },
    ]);

    const res = await request(app).get('/api/v1/ext/demo/things/42');

    assert.deepStrictEqual(res.body, { thingId: '42' });
  });

  it('keeps two extensions in separate namespaces', async () => {
    const app = createApp([
      {
        id: 'one',
        routes: [
          {
            path: '/thing',
            handler: (_req, res) => {
              res.status(200).json({ from: 'one' });
            },
          },
        ],
      },
      {
        id: 'two',
        routes: [
          {
            path: '/thing',
            handler: (_req, res) => {
              res.status(200).json({ from: 'two' });
            },
          },
        ],
      },
    ]);

    assert.deepStrictEqual(
      (await request(app).get('/api/v1/ext/one/thing')).body,
      { from: 'one' }
    );
    assert.deepStrictEqual(
      (await request(app).get('/api/v1/ext/two/thing')).body,
      { from: 'two' }
    );
  });

  it('404s a path the extension did not register', async () => {
    const app = createApp([{ id: 'demo', routes: [{ path: '/things' }] }]);

    const res = await request(app).get('/api/v1/ext/demo/other');

    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.status, 404);
  });

  it('404s an extension that is not installed', async () => {
    const app = createApp([{ id: 'demo', routes: [{ path: '/things' }] }]);

    assert.strictEqual(
      (await request(app).get('/api/v1/ext/absent/things')).status,
      404
    );
  });

  it('404s the routes of a quarantined extension', async () => {
    const app = createApp([
      { id: 'broken', failed: true, routes: [{ path: '/things' }] },
    ]);

    assert.strictEqual(
      (await request(app).get('/api/v1/ext/broken/things')).status,
      404
    );
  });

  it('keeps one extension mounted when another is quarantined', async () => {
    const app = createApp([
      { id: 'broken', failed: true, routes: [{ path: '/things' }] },
      { id: 'demo', routes: [{ path: '/things' }] },
    ]);

    assert.strictEqual(
      (await request(app).get('/api/v1/ext/demo/things')).status,
      200
    );
    assert.strictEqual(
      (await request(app).get('/api/v1/ext/broken/things')).status,
      404
    );
  });

  it('refuses a route path that escapes its own namespace', async () => {
    const app = createApp([
      { id: 'demo', routes: [{ path: '/../other/things' }] },
      { id: 'demo-two', routes: [{ path: '/things' }] },
    ]);

    assert.strictEqual(
      (await request(app).get('/api/v1/ext/demo/../other/things')).status,
      404
    );
    assert.strictEqual(
      (await request(app).get('/api/v1/ext/demo-two/things')).status,
      200
    );
  });

  it('skips a route express cannot compile and mounts the rest', async () => {
    const app = createApp([
      {
        id: 'demo',
        routes: [{ path: '/things/*' }, { path: '/other' }],
      },
    ]);

    assert.strictEqual(
      (await request(app).get('/api/v1/ext/demo/other')).status,
      200
    );
  });
});

describe('extension router permissions', () => {
  const declarations = [
    {
      permission: 'demo:view_own',
      extensionId: 'demo',
      key: 'view_own',
      name: 'View Own',
      default: false,
      requiresCore: [],
    },
  ];

  function gatedApp(permission: string): Express {
    setExtensionPermissionDeclarations(() => declarations);

    return createApp([
      { id: 'demo', routes: [{ path: '/things', options: { permission } }] },
    ]);
  }

  it('403s an anonymous request to a gated route', async () => {
    const res = await request(gatedApp('view_own')).get(
      '/api/v1/ext/demo/things'
    );

    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(res.body, {
      status: 403,
      error: 'You do not have permission to access this endpoint',
    });
  });

  it('403s a user without the extension permission', async () => {
    const friend = await getUser('friend@seerr.dev');

    const res = await asUser(
      request(gatedApp('view_own')).get('/api/v1/ext/demo/things'),
      friend.id
    );

    assert.strictEqual(res.status, 403);
  });

  it('allows a user granted the extension permission', async () => {
    const friend = await getUser('friend@seerr.dev');
    await grantExtensionPermission(friend.id, 'demo:view_own');

    const res = await asUser(
      request(gatedApp('view_own')).get('/api/v1/ext/demo/things'),
      friend.id
    );

    assert.strictEqual(res.status, 200);
  });

  it('namespaces a bare permission key against the declaring extension', async () => {
    const friend = await getUser('friend@seerr.dev');
    await grantExtensionPermission(friend.id, 'demo:view_own');

    const res = await asUser(
      request(gatedApp('demo:view_own')).get('/api/v1/ext/demo/things'),
      friend.id
    );

    assert.strictEqual(res.status, 200);
  });

  it('enforces a core permission named in the route options', async () => {
    const app = createApp([
      {
        id: 'demo',
        routes: [{ path: '/things', options: { permission: 'MANAGE_USERS' } }],
      },
    ]);
    const friend = await getUser('friend@seerr.dev');
    const admin = await getUser('admin@seerr.dev');

    assert.strictEqual(
      (await asUser(request(app).get('/api/v1/ext/demo/things'), friend.id))
        .status,
      403
    );
    assert.strictEqual(
      (await asUser(request(app).get('/api/v1/ext/demo/things'), admin.id))
        .status,
      200
    );
  });

  it('leaves an ungated route open to any authenticated user', async () => {
    const app = createApp([{ id: 'demo', routes: [{ path: '/things' }] }]);
    const friend = await getUser('friend@seerr.dev');

    assert.strictEqual(
      (await asUser(request(app).get('/api/v1/ext/demo/things'), friend.id))
        .status,
      200
    );
  });

  it('exposes the authenticated user to the handler', async () => {
    const app = createApp([
      {
        id: 'demo',
        routes: [
          {
            path: '/whoami',
            handler: (req, res) => {
              res.status(200).json({ email: req.user?.email });
            },
          },
        ],
      },
    ]);
    const friend = await getUser('friend@seerr.dev');

    const res = await asUser(
      request(app).get('/api/v1/ext/demo/whoami'),
      friend.id
    );

    assert.deepStrictEqual(res.body, { email: 'friend@seerr.dev' });
  });
});

describe('extension router body validation', () => {
  const schema = z.object({
    count: z.coerce.number(),
    tag: z.string().default('none'),
  });

  function validatingApp(): Express {
    return createApp([
      {
        id: 'demo',
        routes: [
          {
            method: 'post',
            path: '/things',
            options: { body: schema },
            handler: (req, res) => {
              res.status(200).json({ body: req.body });
            },
          },
        ],
      },
    ]);
  }

  it('400s a body the schema rejects', async () => {
    const res = await request(validatingApp())
      .post('/api/v1/ext/demo/things')
      .send({ count: 'not a number' });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.status, 400);
    assert.ok(res.body.errors?.length);
  });

  it('400s a missing body', async () => {
    const res = await request(validatingApp()).post('/api/v1/ext/demo/things');

    assert.strictEqual(res.status, 400);
  });

  it('passes the parsed body to the handler', async () => {
    const res = await request(validatingApp())
      .post('/api/v1/ext/demo/things')
      .send({ count: '3' });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.body, { count: 3, tag: 'none' });
  });

  it('does not validate a route that declared no schema', async () => {
    const app = createApp([
      {
        id: 'demo',
        routes: [
          {
            method: 'post',
            path: '/things',
            handler: (req, res) => {
              res.status(200).json({ body: req.body });
            },
          },
        ],
      },
    ]);

    const res = await request(app)
      .post('/api/v1/ext/demo/things')
      .send({ anything: true });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.body, { anything: true });
  });

  it('checks the permission before the body', async () => {
    setExtensionPermissionDeclarations(() => [
      {
        permission: 'demo:view_own',
        extensionId: 'demo',
        key: 'view_own',
        name: 'View Own',
        default: false,
        requiresCore: [],
      },
    ]);
    const app = createApp([
      {
        id: 'demo',
        routes: [
          {
            method: 'post',
            path: '/things',
            options: { permission: 'view_own', body: schema },
          },
        ],
      },
    ]);

    const res = await request(app)
      .post('/api/v1/ext/demo/things')
      .send({ count: 'not a number' });

    assert.strictEqual(res.status, 403);
  });
});

describe('extension router handler failures', () => {
  it('500s a handler that throws', async () => {
    const app = createApp([
      {
        id: 'demo',
        routes: [
          {
            path: '/things',
            handler: () => {
              throw new Error('handler exploded');
            },
          },
        ],
      },
    ]);

    const res = await request(app).get('/api/v1/ext/demo/things');

    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.status, 500);
  });

  it('500s a handler that rejects', async () => {
    const app = createApp([
      {
        id: 'demo',
        routes: [
          {
            path: '/things',
            handler: async () => {
              throw new Error('handler rejected');
            },
          },
        ],
      },
    ]);

    assert.strictEqual(
      (await request(app).get('/api/v1/ext/demo/things')).status,
      500
    );
  });

  it('does not leak the handler error message to the client', async () => {
    const app = createApp([
      {
        id: 'demo',
        routes: [
          {
            path: '/things',
            handler: async () => {
              throw new Error('database password is hunter2');
            },
          },
        ],
      },
    ]);

    const res = await request(app).get('/api/v1/ext/demo/things');

    assert.doesNotMatch(JSON.stringify(res.body), /hunter2/);
  });

  it('leaves a response the handler already sent alone', async () => {
    const app = createApp([
      {
        id: 'demo',
        routes: [
          {
            path: '/things',
            handler: async (_req, res) => {
              res.status(202).json({ accepted: true });
              throw new Error('exploded after responding');
            },
          },
        ],
      },
    ]);

    const res = await request(app).get('/api/v1/ext/demo/things');

    assert.strictEqual(res.status, 202);
    assert.deepStrictEqual(res.body, { accepted: true });
  });

  it('keeps serving the other routes after one throws', async () => {
    const app = createApp([
      {
        id: 'demo',
        routes: [
          {
            path: '/broken',
            handler: async () => {
              throw new Error('handler exploded');
            },
          },
          { path: '/fine' },
        ],
      },
    ]);

    assert.strictEqual(
      (await request(app).get('/api/v1/ext/demo/broken')).status,
      500
    );
    assert.strictEqual(
      (await request(app).get('/api/v1/ext/demo/fine')).status,
      200
    );
  });
});

/**
 * Constraint 3 (docs/specs/extension-system.md): the OpenAPI validator rejects
 * any path `seerr-api.yml` does not document, and extension paths cannot be in
 * that file because they are unknown at build time. These tests pin the mount
 * order that makes extension routes reachable at all — move the extension
 * router below the validator and the first of them fails with a 404.
 */
describe('extension router ahead of the OpenAPI validator', () => {
  function createValidatedApp(): Express {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/ext',
      createExtensionRouter(
        registryWith([{ id: 'demo', routes: [{ path: '/things' }] }])
      )
    );
    app.use(
      OpenApiValidator.middleware({
        apiSpec: API_SPEC_PATH,
        validateRequests: true,
      })
    );
    app.use(
      (
        err: { status?: number; message?: string; errors?: unknown[] },
        _req: express.Request,
        res: express.Response,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _next: express.NextFunction
      ) => {
        res
          .status(err.status ?? 500)
          .json({ message: err.message, errors: err.errors });
      }
    );

    return app;
  }

  it('reaches an extension route that seerr-api.yml does not document', async () => {
    const res = await request(createValidatedApp()).get(
      '/api/v1/ext/demo/things'
    );

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ok: true });
  });

  it('still rejects an undocumented path that is not an extension route', async () => {
    const res = await request(createValidatedApp()).get(
      '/api/v1/not-in-the-spec'
    );

    assert.strictEqual(res.status, 404);
  });

  it('still validates the body of a documented core route', async () => {
    const res = await request(createValidatedApp())
      .post('/api/v1/settings/jobs/plex-full-scan/schedule')
      .set('X-Api-Key', API_KEY)
      .send({ schedule: 5 });

    assert.strictEqual(res.status, 400);
  });
});
