/**
 * Publishes the host's live modules for runtime-loaded extension panels.
 *
 * A panel is a pre-built ESM bundle the browser `import()`s, so it cannot be
 * bundled with the app — but it must use the app's *same* React instance, or its
 * first hook throws the null-dispatcher error. The import map in `_document.tsx`
 * redirects the panel's bare `import 'react'` to a shim served by
 * `server/routes/extensionShared.ts`, and that shim reads the module off the
 * global this file sets.
 *
 * It runs at **module scope**, not in an effect. A panel `import()` can begin as
 * soon as the panel page mounts, and the shim throws if the global is not there
 * yet, so publishing must not wait for React to commit anything.
 *
 * `react-dom/client` is included because the import map must be exhaustive:
 * `react-dom` does not cover its subpaths, and an unmapped bare specifier
 * silently resolves to a second copy of the package rather than failing.
 */
import { uiComponents } from '@app/components/ExtensionUi';
import type { HostModules } from '@server/lib/extensions/sharedModuleSpecifiers';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as ReactIntl from 'react-intl';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import * as Swr from 'swr';

declare global {
  interface Window {
    __seerr_shared__?: Record<string, unknown>;
  }
}

/**
 * Keyed by bare specifier. Typed as `HostModules` — a `Record` over the exact
 * specifier union — so adding a specifier to the shared list without publishing
 * its module here is a compile error rather than a runtime throw at panel load.
 */
export const sharedModules: HostModules = {
  react: React,
  'react/jsx-runtime': ReactJsxRuntime,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
  'react-intl': ReactIntl,
  swr: Swr,
  // Not a third-party package but the host's own components, published under a
  // package name so a panel imports them the same way it imports anything else.
  '@seerr/extension-ui': uiComponents,
};

if (typeof window !== 'undefined') {
  window.__seerr_shared__ = sharedModules;
}
