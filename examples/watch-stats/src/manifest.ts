/**
 * The manifest, as a TypeScript literal.
 *
 * Not `import manifest from '../seerr-extension.json'`, for the reason
 * `examples/watch-history/src/manifest.ts` spells out at length: `resolveJsonModule`
 * widens as it infers, so every `DeclaredCapability` conditional fails to match
 * and an imported JSON manifest narrows *nothing*. `as const` on a TS literal is
 * the fix, at the cost of a second copy — which is why the integration test
 * asserts the two are deep-equal.
 */
import type { ExtensionManifestInput } from '@seerr/extension-sdk';

export const manifest = {
  id: 'watch-stats',
  name: 'Watch Stats',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  description:
    'Brings play counts from Tautulli or Tracearr into Seerr: what your users are actually watching, what is trending, and what to watch next.',
  server: 'dist/index.js',
  requires: {
    // Watch records name a user; the panel names them back.
    users: 'read',
    // `findByRatingKey` and `findByTmdbId` are how a play is attributed to a
    // title, and `getDetails` is how the panel gets a poster.
    media: 'read',
    // Read-only TMDB, for the "what to watch next" half. Without this the
    // extension would need its own key, bypassing core's cache and rate limiter.
    discover: 'read',
    // Watch history from the Tautulli server core is already configured with, so
    // the operator does not enter the same hostname twice. Read-only, and core
    // keeps the API key — see `sdk.tautulli` in the spec for why that split
    // matters. Note this is granted only when the operator has *also* configured
    // Tautulli, which is why `src/index.ts` treats its absence as a normal state.
    tautulli: 'read',
    // `settings.tautulli` — which server core is pointed at, for the panel to
    // show — plus this extension's own values.
    settings: 'read',
    store: true,
    jobs: true,
    // No `http`, deliberately. Both sources are self-hosted at an address the
    // *operator* chooses, so there is no hostname an extension author can
    // truthfully list — and listing a plausible-looking placeholder would make
    // the field a lie, which is worse than an omission in a manifest whose whole
    // job is to describe honestly what the extension touches. The allowlist is
    // advisory in v1 either way; if it becomes enforced it will need a form that
    // can say "whatever the operator configured".
  },
  provides: {
    permissions: [
      {
        key: 'view_own',
        name: 'View Own Watch Stats',
        description:
          'See your own play counts and what you have been watching.',
        default: true,
      },
      {
        key: 'view_all',
        name: 'View All Watch Stats',
        description:
          "See every user's play counts, and the server-wide trending list.",
        requiresCore: ['MANAGE_USERS'],
      },
    ],
    settings: [
      {
        key: 'source',
        type: 'select',
        name: 'Watch history source',
        description:
          'Where play records come from. Tautulli uses the server Seerr is already configured with; Tracearr needs the host and token below.',
        options: [
          { value: 'tautulli', label: 'Tautulli' },
          { value: 'tracearr', label: 'Tracearr' },
        ],
        default: 'tautulli',
      },
      {
        key: 'tracearr_url',
        type: 'string',
        name: 'Tracearr URL',
        description:
          'Base URL of your Tracearr server, including any path prefix — for example https://tracearr.example.com. Ignored when the source is Tautulli.',
      },
      {
        key: 'tracearr_token',
        type: 'secret',
        name: 'Tracearr API token',
        description:
          'A public API token from Tracearr’s Settings › General. Starts with "trr_pub_".',
      },
      {
        key: 'trend_days',
        type: 'number',
        name: 'Trending window (days)',
        description:
          'How far back the "trending on your server" list looks. Longer is steadier; shorter reacts faster.',
        default: 7,
        min: 1,
        max: 90,
      },
    ],
    panels: [
      {
        slug: 'stats',
        title: 'Watch Stats',
        entry: 'dist/panel.js',
        sidebar: { icon: 'ChartBarIcon', order: 55 },
        permission: 'view_own',
      },
    ],
    jobs: [
      {
        id: 'sync',
        name: 'Sync Watch Stats',
        // Hourly. The sources aggregate plays themselves, so this is a refresh
        // of a cache rather than an incremental ingest that would fall behind.
        schedule: '0 * * * *',
      },
    ],
  },
} as const satisfies ExtensionManifestInput;
