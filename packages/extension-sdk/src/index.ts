/**
 * `@seerr/extension-sdk` — types and helpers for building a Seerr extension.
 *
 * The contract is `server/lib/extensions/types.ts` in the Seerr repository; this
 * package is its publishable mirror plus {@link defineExtension}. It has no
 * runtime coupling to Seerr internals, and at runtime consists of exactly one
 * function.
 *
 * Extensions are **trusted code**: the host `require()`s the entry point into the
 * Seerr process and hands it an SDK object. The manifest's `requires` shapes that
 * object, but it is capability hygiene rather than a sandbox — see
 * `docs/specs/extension-system.md`, "Trust model".
 */

export { defineExtension } from './defineExtension';
export type {
  DeclaredCapability,
  ExtensionDefinition,
  ExtensionEntity,
  ExtensionMigration,
  ExtensionModule,
  NarrowedExtensionSdk,
} from './defineExtension';

export { DbAwareColumn, resolveColumnType } from './columns';

export { SeerrPermission } from './entities';
export type {
  SeerrMainSettings,
  SeerrMedia,
  SeerrMediaRequest,
  SeerrMediaRequestStatus,
  SeerrMediaStatus,
  SeerrMediaType,
  SeerrPermissionName,
  SeerrPermissionValue,
  SeerrSeasonRequest,
  SeerrTautulliSettings,
  SeerrUser,
  SeerrUserType,
} from './entities';

export type {
  ExtensionAccessLevel,
  ExtensionDiscover,
  ExtensionDiscoverMediaType,
  ExtensionEvent,
  ExtensionEventMap,
  ExtensionEvents,
  ExtensionJobs,
  ExtensionKvStore,
  ExtensionMedia,
  ExtensionMediaDetails,
  ExtensionMediaWrite,
  ExtensionNotificationPayload,
  ExtensionNotify,
  ExtensionPermissionKey,
  ExtensionRequestBody,
  ExtensionRequests,
  ExtensionRequestsQuery,
  ExtensionRouteHandler,
  ExtensionRouteOptions,
  ExtensionRouteRegistrar,
  ExtensionRouteRequest,
  ExtensionRouter,
  ExtensionSdk,
  ExtensionSettingValue,
  ExtensionSettings,
  ExtensionSetup,
  ExtensionStore,
  ExtensionTautulli,
  ExtensionUsers,
  ExtensionWatchRecord,
  ExtensionWatchTotals,
} from './types';

export type {
  ExtensionId,
  ExtensionManifest,
  ExtensionManifestJob,
  ExtensionManifestNotification,
  ExtensionManifestPanel,
  ExtensionManifestPermission,
  ExtensionManifestProvides,
  ExtensionManifestRequires,
  ExtensionManifestSetting,
  ExtensionManifestSettingOption,
  ExtensionPanelIcon,
  ExtensionSettingType,
} from './manifest';

export type { ExtensionManifestInput } from './manifestInput';
