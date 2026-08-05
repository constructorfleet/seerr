/**
 * The manifest, as a TypeScript literal.
 *
 * ## Why this is not `import manifest from '../seerr-extension.json'`
 *
 * `defineExtension` recovers non-optional SDK capabilities from the manifest's
 * *literal* type: `requires: { store: true }` is what makes `sdk.store`
 * non-optional. TypeScript's `resolveJsonModule` widens as it infers — a JSON
 * `true` becomes `boolean`, `"read"` becomes `string`, and a JSON array becomes
 * `T[]` rather than a tuple. Every conditional in `DeclaredCapability` then fails
 * to match, so an imported JSON manifest silently narrows *nothing*: `sdk.store`
 * stays `ExtensionStore | undefined` and the author is back to `sdk.store!`.
 *
 * `as const` on a TS literal is the fix, and it costs a second copy of the
 * manifest — which is why `manifest.test.ts` asserts the two are deep-equal. The
 * host only ever reads the JSON file from disk; this object exists for its type.
 *
 * The SDK's own docs recommend the JSON import. That advice is wrong for any
 * manifest whose narrowing matters, and fixing it is a follow-up on the SDK, not
 * on this extension.
 */
import type { ExtensionManifestInput } from '@seerr/extension-sdk';

export const manifest = {
  id: 'watch-history',
  name: 'Watch History',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  description:
    'Records what each user has watched, and shows them their own history.',
  server: 'dist/index.js',
  requires: {
    users: 'read',
    media: 'read',
    requests: 'read',
    settings: 'read',
    store: true,
    jobs: true,
    http: ['plex.tv'],
  },
  provides: {
    permissions: [
      {
        key: 'view_own',
        name: 'View Own Watch History',
        description: 'See your own watch history.',
        default: true,
      },
      {
        key: 'view_all',
        name: 'View All Watch History',
        description: "See every user's watch history.",
        requiresCore: ['MANAGE_USERS'],
      },
    ],
    notifications: [
      {
        key: 'milestone',
        name: 'Watch Milestone',
        description: 'Sent when you reach a round number of watched items.',
        default: false,
      },
    ],
    panels: [
      {
        slug: 'history',
        title: 'Watch History',
        entry: 'dist/panel.js',
        sidebar: { icon: 'ClockIcon', order: 50 },
        permission: 'view_own',
      },
    ],
    jobs: [
      {
        id: 'sync',
        name: 'Sync Watch History',
        schedule: '0 */6 * * *',
      },
    ],
  },
} as const satisfies ExtensionManifestInput;
