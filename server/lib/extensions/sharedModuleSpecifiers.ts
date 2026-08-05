/**
 * The bare specifiers an extension panel may import and get the host's copy of.
 *
 * Its own module, with **no imports**, because three places must agree on this
 * list and two of them are on opposite sides of the bundler:
 *
 * - `server/routes/extensionShared.ts` generates one ESM shim per specifier.
 * - `src/utils/extensionSharedModules.ts` publishes the host module under each
 *   key for those shims to read.
 * - `src/pages/_document.tsx` emits the import map pointing each specifier at its
 *   shim.
 *
 * The list must be **exhaustive** with respect to what panels import. An
 * unmapped bare specifier does not fail loudly: it resolves to a second copy of
 * the package, which renders fine and then breaks on the first hook. Note that
 * `react-dom` does not cover `react-dom/client` — subpaths are separate entries.
 */
export const SHARED_MODULE_SPECIFIERS = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  'react-intl',
  'swr',
] as const;

export type SharedModuleSpecifier = (typeof SHARED_MODULE_SPECIFIERS)[number];

/**
 * `react/jsx-dev-runtime` is the one specifier with no host module of its own: a
 * production React's jsx-runtime has no `jsxDEV`, so its shim adapts the
 * jsx-runtime's signature rather than re-exporting anything.
 */
export type HostModuleSpecifier = Exclude<
  SharedModuleSpecifier,
  'react/jsx-dev-runtime'
>;

/**
 * A host module for every specifier that needs one — `Record` over the exact
 * key union, so both the client publisher and the server's shim generator get a
 * type error if the specifier list gains an entry they do not handle. Drift here
 * fails silently at runtime (a second copy of a package that renders fine and
 * breaks on the first hook), so it is worth making it a compile error.
 */
export type HostModules = Record<HostModuleSpecifier, unknown>;

/** Where the shims are mounted. Must stay above the OpenAPI validator. */
export const SHARED_MODULE_BASE_PATH = '/api/v1/ext-shared';

/** The filename a specifier is served as: `react/jsx-runtime` → `react-jsx-runtime.mjs`. */
export function sharedModuleFilename(specifier: SharedModuleSpecifier): string {
  return `${specifier.replace(/\//g, '-')}.mjs`;
}

/**
 * The URL the import map points a specifier at.
 *
 * `buildTag` exists only so the URL changes when the host's module surface might
 * have; it is not a lookup key, and the server serves this build's shims under
 * any tag.
 */
export function sharedModuleUrl(
  specifier: SharedModuleSpecifier,
  buildTag: string
): string {
  return `${SHARED_MODULE_BASE_PATH}/${buildTag}/${sharedModuleFilename(specifier)}`;
}

/** The import map body, as a JSON string ready for a `<script type="importmap">`. */
export function sharedModuleImportMap(buildTag: string): string {
  return JSON.stringify({
    imports: Object.fromEntries(
      SHARED_MODULE_SPECIFIERS.map((specifier) => [
        specifier,
        sharedModuleUrl(specifier, buildTag),
      ])
    ),
  });
}
