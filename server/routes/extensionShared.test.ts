/**
 * The shared-module shim router that extension panels' bare imports resolve to.
 *
 * The point of these shims is *identity*: a panel's `import 'react'` must reach
 * the very React instance the host app tree is rendering with, or hooks fail
 * with the null-dispatcher error. The shims are what make that true, so the
 * tests here pin the properties identity depends on — the export list is
 * complete, every binding is read off the host global rather than re-created,
 * and nothing is served for a specifier the import map does not name.
 *
 * The browser half (the import map actually redirecting, and hooks working
 * across the boundary) was verified manually during the spike; see
 * docs/specs/spike-panels/README.md. It cannot be asserted from node:test.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sharedModuleImportMap } from '@server/lib/extensions/sharedModuleSpecifiers';
import {
  SHARED_MODULE_SPECIFIERS,
  createExtensionSharedRouter,
  sharedModuleFilename,
} from '@server/routes/extensionShared';
import express from 'express';
import request from 'supertest';

function appWithRouter() {
  const app = express();
  app.use('/api/v1/ext-shared', createExtensionSharedRouter());
  return app;
}

describe('extension shared-module shims', () => {
  it('serves a shim for every specifier the import map names', async () => {
    const app = appWithRouter();

    for (const specifier of SHARED_MODULE_SPECIFIERS) {
      const res = await request(app).get(
        `/api/v1/ext-shared/local/${sharedModuleFilename(specifier)}`
      );

      assert.equal(res.status, 200, `${specifier} should be served`);
      assert.match(res.headers['content-type'], /javascript/);
    }
  });

  it('re-exports the host module rather than constructing its own', async () => {
    const res = await request(appWithRouter()).get(
      '/api/v1/ext-shared/local/react.mjs'
    );

    // The whole mechanism rests on this: bindings are read off the host global.
    // A shim that imported or re-implemented anything would be a second React.
    assert.match(res.text, /globalThis\.__seerr_shared__/);
    assert.doesNotMatch(res.text, /^\s*import\s/m);
  });

  it("exports the host React's real surface", async () => {
    const res = await request(appWithRouter()).get(
      '/api/v1/ext-shared/local/react.mjs'
    );

    // Named exports are generated from the installed react, so a panel using a
    // hook the host has cannot get `undefined` for it.
    for (const name of ['useState', 'useEffect', 'createElement', 'Fragment']) {
      assert.match(res.text, new RegExp(`\\b${name}\\b`), `exports ${name}`);
    }
  });

  it('adapts jsxDEV onto a production host runtime', async () => {
    const res = await request(appWithRouter()).get(
      '/api/v1/ext-shared/local/react-jsx-dev-runtime.mjs'
    );

    assert.equal(res.status, 200);
    // A dev-built panel imports `jsxDEV`, which a production react's
    // jsx-runtime does not have. Exporting `undefined` would crash the panel on
    // its first element, so the shim supplies a signature adapter.
    assert.match(res.text, /jsxDEV/);
    assert.match(res.text, /jsxs?\(/);
  });

  it('does not serve a file outside the shim set', async () => {
    const app = appWithRouter();

    for (const file of [
      'nope.mjs',
      'react.mjs.map',
      '..%2f..%2fpackage.json',
      'react',
    ]) {
      const res = await request(app).get(`/api/v1/ext-shared/local/${file}`);

      assert.equal(res.status, 404, `${file} should not be served`);
    }
  });

  it('maps every specifier to the URL it is served at', async () => {
    const app = appWithRouter();
    const { imports } = JSON.parse(sharedModuleImportMap('some-tag')) as {
      imports: Record<string, string>;
    };

    assert.deepEqual(
      Object.keys(imports).sort(),
      [...SHARED_MODULE_SPECIFIERS].sort()
    );

    // Every URL the map emits must actually resolve, or the panel's import
    // rejects at link time.
    for (const url of Object.values(imports)) {
      assert.equal(
        (await request(app).get(url)).status,
        200,
        `${url} resolves`
      );
    }
  });

  it('serves the same shim under any build tag', async () => {
    const app = appWithRouter();

    // The tag exists only to bust caches across a Seerr upgrade; the running
    // process has exactly one build, so it is not a lookup key.
    const tagged = await request(app).get(
      '/api/v1/ext-shared/some-other-tag/react.mjs'
    );

    assert.equal(tagged.status, 200);
  });
});
