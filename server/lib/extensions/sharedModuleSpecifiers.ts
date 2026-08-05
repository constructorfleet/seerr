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
  /**
   * The host's own components, so a panel can look like Seerr.
   *
   * Shared for a different reason than the rest of this list. React is here for
   * *identity* — a second instance breaks hooks. This is here for *CSS*: a panel
   * is a pre-built bundle, so the host's Tailwind JIT never sees its class names
   * and emits nothing for them, meaning a hand-styled panel silently renders
   * with classes that do not exist. Re-exporting components whose classes are
   * already compiled into the host bundle is the only version of this that
   * cannot drift. See `./uiComponents.ts`.
   */
  '@seerr/extension-ui',
] as const;

export type SharedModuleSpecifier = (typeof SHARED_MODULE_SPECIFIERS)[number];

/**
 * Specifiers whose host module the *client* publishes. Everything shared has an
 * entry except `react/jsx-dev-runtime`, which has no module of its own: a
 * production React's jsx-runtime has no `jsxDEV`, so its shim adapts the
 * jsx-runtime's signature rather than re-exporting anything.
 */
export type HostModuleSpecifier = Exclude<
  SharedModuleSpecifier,
  'react/jsx-dev-runtime'
>;

/**
 * Specifiers whose shim the server generates by enumerating the installed
 * module's own keys.
 *
 * Narrower than {@link HostModuleSpecifier} by one: `@seerr/extension-ui` resolves
 * to `src/components/ExtensionUi`, and the server tsconfig has no `@app/*` path —
 * deliberately, since server code must not depend on the client build. Its export
 * list comes from `./uiComponents.ts` instead, which imports nothing and so can be
 * read from either side.
 */
export type EnumerableModuleSpecifier = Exclude<
  HostModuleSpecifier,
  '@seerr/extension-ui'
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
 * `buildTag` is cosmetic: it is not a lookup key, and the server serves this
 * build's shims under any tag. It is **not** load-bearing for cache correctness
 * either — it is constant on any source build, since `COMMIT_TAG` is injected
 * only by the release Dockerfile — so the shim route validates with a
 * content-derived ETag instead. See the caching comment there.
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
