/**
 * The extension from README.md, compiled.
 *
 * A README example that does not typecheck is worse than none, and this one exists
 * to demonstrate the narrowing — so the claim that `sdk.store` is non-optional and
 * `sdk.users` is absent has to be checked, not asserted in prose. Kept in
 * `conformance/` rather than `src/` so it never reaches `dist/`.
 *
 * Deliberately not `export =`, which the real entry point uses: that form is only
 * meaningful in a module the host `require()`s, and it cannot coexist with the
 * other exports this file needs. What `export =` does and why is covered in
 * `defineExtension`'s own documentation.
 */
import { defineExtension } from '../src/defineExtension';
import type { ExtensionManifest } from '../src/manifest';

/**
 * The manifest as a TypeScript literal, mirroring the extension's
 * `seerr-extension.json`.
 *
 * Deliberately *not* `import manifest from '../seerr-extension.json'`, which the
 * README used to recommend: `resolveJsonModule` widens `true` to `boolean` and
 * `'read'` to `string`, so every conditional in `DeclaredCapability` fails to
 * match and the narrowing silently does nothing. `as const satisfies` is what
 * keeps the literal types the narrowing reads — `satisfies` rather than a
 * `: ExtensionManifest` annotation, which would widen them too.
 */
const manifest = {
  id: 'watch-history',
  name: 'Watch History',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  server: 'dist/server.js',
  requires: {
    store: true,
    media: 'read',
  },
  provides: {
    permissions: [{ key: 'view_own', name: 'View Own History', default: true }],
  },
} as const satisfies ExtensionManifest;

/** Stands in for the extension's own entity. */
class WatchEvent {
  public id: number;
  public userId: number;
}

export const watchHistory = defineExtension({
  manifest,
  entities: [WatchEvent],
  setup(sdk) {
    // `store` and `media` are non-optional here, because the manifest declares
    // them: no `!`, no `?.`.
    sdk.router.get('/history', { permission: 'view_own' }, async (req, res) => {
      const events = await sdk.store.getRepository(WatchEvent).find({
        where: { userId: req.user!.id },
      });

      res.json(events);
    });

    sdk.events.on('media.available', async ({ media }) => {
      sdk.logger.info(`${media.tmdbId} became available`);
    });

    // And the other half of the claim: `users` was not required, so it is not
    // merely optional but absent. `@ts-expect-error` fails the build if this ever
    // starts compiling.
    // @ts-expect-error `users` is not declared by this manifest
    void sdk.users;
  },
});
