/**
 * The manifest, as a TypeScript literal.
 *
 * Two copies of a manifest is not a mistake, and for *this* extension the second
 * one is load-bearing in a way it is not for a read-only one. `defineExtension`
 * recovers non-optional SDK capabilities from the manifest's *literal* type, and
 * for `media` it recovers the **access level** too: `requires: { media: 'write' }`
 * is what makes `sdk.media.remove` exist on the type at all. TypeScript widens as
 * it infers from JSON — `'write'` becomes `string`, `true` becomes `boolean` — so
 * an imported `seerr-extension.json` narrows nothing, and the one member this
 * whole extension is built around would be a compile error.
 *
 * The cost is a copy that can drift, which is why a test in the Seerr repository
 * (`server/lib/extensions/removalRequestExtension.test.ts`) asserts the two are
 * deep-equal. The host only ever reads the JSON file from disk; this object
 * exists for its type.
 *
 * ## The notification keys are the extension's own, deliberately
 *
 * An earlier, in-core version of this feature added three members to core's
 * `Notification` enum starting at bit 8192. That is not available to an
 * extension, and it is no longer available to core either: 8192 is
 * `Notification.EXTENSION`, the single sentinel every extension notification is
 * persisted and subscribed under. So the keys below are namespaced
 * `media-removal:<key>` by the host, delivery goes through `sdk.notify.send`, and
 * nothing here references a bit. An operator's per-agent subscription still
 * works — the host resolves it — and core's enum is untouched.
 */
import type { ExtensionManifestInput } from '@seerr/extension-sdk';

export const manifest = {
  id: 'media-removal',
  name: 'Media Removal Requests',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  description:
    'Lets users request removal of media they requested, with approval, and deletes it from Radarr/Sonarr once approved.',
  server: 'dist/index.js',
  requires: {
    users: 'read',
    // The only `'write'` in `examples/`, and the reason this extension exists.
    // `'read'` would typecheck everywhere except the one call that matters.
    media: 'write',
    // To answer "did you request this yourself?" without a repository for core's
    // `MediaRequest`.
    requests: 'read',
    settings: 'read',
    store: true,
  },
  provides: {
    permissions: [
      {
        key: 'request',
        name: 'Request Media Removal',
        description:
          'Ask for media you requested to be removed, deleting its files.',
        // Unrequesting only means anything to someone who can request, and the
        // core check is what stops this being a way to grant deletion to a user
        // with no request rights at all.
        requiresCore: ['REQUEST'],
        // Not granted to new users: every other permission in this manifest is
        // about *reviewing* a deletion, and this one is about asking for one.
        default: false,
      },
      {
        key: 'manage',
        name: 'Manage Removal Requests',
        description:
          "Approve, decline and withdraw other users' removal requests.",
        requiresCore: ['MANAGE_REQUESTS'],
      },
    ],
    notifications: [
      {
        key: 'pending',
        name: 'Removal Requested',
        description: 'Sent when a removal request needs approval.',
        default: true,
      },
      {
        key: 'approved',
        name: 'Removal Approved',
        description:
          'Sent when a removal request is approved and the media is deleted.',
        default: true,
      },
      {
        key: 'declined',
        name: 'Removal Declined',
        description: 'Sent when a removal request is declined.',
        default: true,
      },
      {
        // The odd one out at `default: false`: it fires on the path where nobody
        // had to decide anything, so for an operator who auto-approves it is one
        // notification per removal and no decision to make. The other four each
        // report something a human either has to act on or would want to know
        // went wrong.
        key: 'auto_approved',
        name: 'Removal Automatically Approved',
        description: 'Sent when a removal request was approved without review.',
        default: false,
      },
      {
        // Distinct from `declined`: a decline is a person saying no, a failure is
        // Radarr/Sonarr saying it could not. Reusing `declined` for both would
        // tell a user their request was refused when in fact it is still true and
        // the operator has a broken arr.
        key: 'failed',
        name: 'Removal Failed',
        description: 'Sent when an approved removal could not be carried out.',
        default: true,
      },
    ],
    panels: [
      {
        slug: 'removals',
        title: 'Removal Requests',
        entry: 'dist/panel.js',
        sidebar: { icon: 'TrashIcon', order: 60 },
        // The panel is one screen for both audiences: a requester sees their own
        // rows, an approver sees everyone's plus the approve/decline controls. So
        // it is gated on the lower of the two permissions and the routes it calls
        // do the narrowing.
        permission: 'request',
      },
    ],
  },
} as const satisfies ExtensionManifestInput;
