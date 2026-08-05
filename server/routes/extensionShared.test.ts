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
import { UI_COMPONENT_NAMES } from '@server/lib/extensions/uiComponents';
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

  it('serves a validator rather than an unconditional year-long cache', async () => {
    // The build tag in the path is `commitTag ?? 'local'`, and COMMIT_TAG is
    // injected only by the release Dockerfile — so on a source build the URL is
    // permanently `/local/react.mjs`. The shim body is generated from the
    // installed package's export list, so an `immutable` response would pin a
    // stale export list across a dependency upgrade and break a panel importing
    // a newly added binding.
    const res = await request(appWithRouter()).get(
      '/api/v1/ext-shared/local/react.mjs'
    );

    assert.equal(res.status, 200);
    assert.doesNotMatch(res.headers['cache-control'] ?? '', /immutable/);
    assert.match(res.headers['cache-control'] ?? '', /must-revalidate/);
    assert.ok(res.headers['etag'], 'serves an ETag to revalidate against');
  });

  it('revalidates to 304 when the shim has not changed', async () => {
    const app = appWithRouter();
    const first = await request(app).get('/api/v1/ext-shared/local/react.mjs');

    const second = await request(app)
      .get('/api/v1/ext-shared/local/react.mjs')
      .set('If-None-Match', first.headers['etag']);

    assert.equal(second.status, 304);
  });

  it('gives shims with different content different ETags', async () => {
    const app = appWithRouter();
    const react = await request(app).get('/api/v1/ext-shared/local/react.mjs');
    const swr = await request(app).get('/api/v1/ext-shared/local/swr.mjs');

    // The ETag is derived from the shim body, so it changes whenever the
    // generated export list does — which is the property the build tag failed
    // to provide.
    assert.notEqual(react.headers['etag'], swr.headers['etag']);
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

describe('the @seerr/extension-ui shim', () => {
  /** The specifier's shim filename, via the same mapping the import map uses. */
  const UI_FILE = sharedModuleFilename('@seerr/extension-ui');

  it('is one of the specifiers the import map names', () => {
    // Without this the browser never redirects the panel's bare import, and it
    // resolves against the network instead — a 404, or worse, a real package.
    assert.ok(
      SHARED_MODULE_SPECIFIERS.includes('@seerr/extension-ui'),
      'the UI package must be a shared specifier'
    );
  });

  it('is served, despite its specifier containing a scope slash', async () => {
    // `@seerr/extension-ui` → `@seerr-extension-ui.mjs`. The filename mapping
    // replaces every slash, and this is the first specifier with a leading `@`,
    // so it is worth pinning that it round-trips to something routable.
    const res = await request(appWithRouter()).get(
      `/api/v1/ext-shared/local/${UI_FILE}`
    );

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /javascript/);
  });

  it('exports every component name the host publishes', async () => {
    const res = await request(appWithRouter()).get(
      `/api/v1/ext-shared/local/${UI_FILE}`
    );

    for (const name of UI_COMPONENT_NAMES) {
      assert.match(
        res.text,
        new RegExp(`\\b${name}\\b`),
        `${name} should be re-exported`
      );
    }
  });

  it('reads components off the host global rather than defining them', async () => {
    const res = await request(appWithRouter()).get(
      `/api/v1/ext-shared/local/${UI_FILE}`
    );

    // The reason this package exists: a component defined here would carry no
    // host CSS, which is exactly the failure mode re-exporting avoids.
    assert.match(res.text, /globalThis\.__seerr_shared__/);
    assert.doesNotMatch(res.text, /^\s*import\s/m);
  });

  it('omits the components bound to host pages rather than the design language', () => {
    // Not an oversight — see `uiComponents.ts`. These take host-page-specific
    // props (TMDB discover unions, a settings-route tab list), so exporting them
    // would promise compatibility for markup no panel can use.
    for (const name of ['ListView', 'QuickConnectModal', 'SettingsTabs']) {
      assert.ok(
        !(UI_COMPONENT_NAMES as readonly string[]).includes(name),
        `${name} should not be part of the panel UI surface`
      );
    }
  });
});
