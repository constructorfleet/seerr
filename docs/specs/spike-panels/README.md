# Slice 6 spike: shared React for runtime-loaded panels

Working prototype from the spike that answered the shared-React open question in
`../extension-system.md` ("Panels: runtime-loaded ESM bundles"). Kept because it was verified in a
real browser and slice 6 should start from it rather than re-deriving it.

**This is not wired into the build.** Nothing imports it; the `.patch` files are diffs against
`src/pages/_document.tsx` and `src/pages/index.tsx` as they were at the time of the spike, and they
are illustrative rather than directly appliable.

## What the spike established

The mechanism is an import map **and** a host-provided global, composed — not a choice between them.
The import map redirects an extension panel's bare `import 'react'` to a shim URL; the shim
re-exports the host's already-loaded module off `window.__seerr_shared__`. Both halves are required:
the map alone has nothing to point at, and the global alone does not intercept bare specifiers.

Four facts drove the design, all re-derived from `node_modules` and Next's source:

- React 19.2.6 ships no ESM build, so there is nothing to import directly.
- Next never emits `<script type="module">`, so panels cannot rely on the host's own script tags.
- `react.production.js` contains zero `require()` calls. This is the trap: it loads fine as a
  *second* React instance and fails only later, on the first hook, with the null-dispatcher error.
- `react/jsx-dev-runtime` needs a signature adapter, not a re-export — a dev-built panel imports
  `jsxDEV`, but a production host only has `{ Fragment, jsx, jsxs }`. See `JSX_DEV_SHIM`.

The import map must be **exhaustive**: any bare specifier it omits resolves to a second copy.

## Files

- `extensionShared.ts` — generates the ESM shim modules at module load and serves them. Must be
  mounted **above** the OpenAPI validator, for the same reason `/api/v1/ext` is (constraint 3).
- `_document.patch` — the inline `<script type="importmap">`. Needs a nonce if a CSP is ever added.
- `index.patch` — publishing `window.__seerr_shared__`. In slice 6 this belongs in `_app.tsx` at
  **module scope**, before any panel `import()` can run.

## What slice 6 still has to settle

Recorded in the spec's open questions, and the reason this is a spike and not an implementation:

- Panels were never rendered inside Seerr's real `_app` tree (Layout, `SWRConfig`, `IntlProvider`) —
  only a standalone harness. Highest-value first check.
- Import-map ordering was verified only under `next start`, in Chromium, with no
  `basePath`/`assetPrefix`.
- The shim URL should carry a build tag (`/api/v1/ext-shared/<commitTag>/react.mjs`) so a Seerr
  upgrade busts the cache; the prototype hardcodes `max-age=300`.
- React version coupling is silent — a panel built against React 18 gets 19 with no error.
