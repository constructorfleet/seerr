/**
 * The Seerr entities an extension sees through the SDK, **re-declared
 * structurally** rather than imported.
 *
 * `server/lib/extensions/types.ts` `type`-imports the real `Media`, `User` and
 * `MediaRequest` classes. This package cannot: they are part of a `private: true`
 * application, so there is nothing to peer-depend on, and copying them verbatim
 * would drag in the whole entity graph (`Watchlist`, `Issue`, `Season`,
 * `SeasonRequest`, `UserSettings`, `UserPushSubscription`, `Blocklist`) plus the
 * `@server/*` path alias, `typeorm` decorators, `bcrypt` and `nanoid` — for types
 * an extension only ever reads.
 *
 * So each interface here describes the **persisted column surface** of its
 * entity, and nothing else: no instance methods, no lazy relations, no
 * `AfterLoad`-computed fields. That makes every one of them a width-supertype of
 * the real class, which is the direction that matters — the host hands a real
 * `Media` to code typed against `SeerrMedia`, so real-assignable-to-declared is
 * what has to hold.
 *
 * Drift is caught, not trusted: `conformance/hostContract.ts` typechecks the
 * host's `ExtensionSdk` against this package's, and
 * `server/lib/extensions/sdkPackage.test.ts` runs that typecheck as a test. A
 * column that changes type or disappears fails there rather than in an
 * extension's build.
 */

/** `server/constants/media.ts` `MediaType`. */
export type SeerrMediaType = 'movie' | 'tv';

/**
 * `server/constants/media.ts` `MediaStatus`, as its numeric values.
 *
 * A union of literals rather than a re-declared `enum`: a second enum
 * declaration would be a distinct nominal type that the host's enum is not
 * assignable to, which is exactly the drift this file exists to avoid.
 */
export type SeerrMediaStatus = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** `server/constants/media.ts` `MediaRequestStatus`, as its numeric values. */
export type SeerrMediaRequestStatus = 1 | 2 | 3 | 4 | 5;

/** `server/constants/user.ts` `UserType`, as its numeric values. */
export type SeerrUserType = 1 | 2 | 3 | 4;

/**
 * A Seerr user, as returned by `sdk.users.get`.
 *
 * `password`, `plexToken`, `jellyfinAuthToken` and the other `select: false`
 * columns are omitted deliberately: the repository does not load them, so typing
 * them here would promise a value that is always `undefined`.
 */
export interface SeerrUser {
  id: number;
  email: string;
  username?: string;
  plexUsername?: string | null;
  jellyfinUsername?: string | null;
  /** Named exactly as core computes it in `AfterLoad`, for display. */
  displayName: string;
  userType: SeerrUserType;
  /** Core's `Permission` bitmask. Read with `sdk.users.hasPermission`. */
  permissions: number;
  avatar: string;
  requestCount: number;
  movieQuotaLimit?: number;
  movieQuotaDays?: number;
  tvQuotaLimit?: number;
  tvQuotaDays?: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A media item, as returned by `sdk.media.get` / `sdk.media.findByTmdbId`. */
export interface SeerrMedia {
  id: number;
  mediaType: SeerrMediaType;
  tmdbId: number;
  tvdbId?: number;
  imdbId?: string;
  status: SeerrMediaStatus;
  status4k: SeerrMediaStatus;
  createdAt: Date;
  updatedAt: Date;
  lastSeasonChange: Date;
  mediaAddedAt: Date;
  serviceId?: number | null;
  serviceId4k?: number | null;
  externalServiceId?: number | null;
  externalServiceId4k?: number | null;
  externalServiceSlug?: string | null;
  externalServiceSlug4k?: string | null;
  ratingKey?: string | null;
  ratingKey4k?: string | null;
  jellyfinMediaId?: string | null;
  jellyfinMediaId4k?: string | null;
}

/** A season of a series request. */
export interface SeerrSeasonRequest {
  id: number;
  seasonNumber: number;
  status: SeerrMediaRequestStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A media request, as returned by `sdk.requests.list` / `sdk.requests.get`.
 *
 * `media`, `requestedBy` and `seasons` are present because the SDK loads those
 * relations; `modifiedBy` is optional because it is only set once a request has
 * been acted on.
 */
export interface SeerrMediaRequest {
  id: number;
  status: SeerrMediaRequestStatus;
  type: SeerrMediaType;
  media: SeerrMedia;
  requestedBy: SeerrUser;
  modifiedBy?: SeerrUser;
  seasons: SeerrSeasonRequest[];
  seasonCount: number;
  is4k: boolean;
  serverId: number;
  profileId: number;
  rootFolder: string;
  languageProfileId: number;
  tags?: number[];
  isAutoRequest: boolean;
  ignoreQuota: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * `sdk.settings.main`, the readable subset of core's `MainSettings`.
 *
 * `apiKey` is on the real interface but the loader blanks it before handing the
 * object over, so it is not declared here — an extension that reads it gets an
 * empty string, and promising it a key would be a lie.
 */
export interface SeerrMainSettings {
  applicationTitle: string;
  applicationUrl: string;
  cacheImages: boolean;
  defaultPermissions: number;
  defaultQuotas: {
    movie: { quotaLimit?: number; quotaDays?: number };
    tv: { quotaLimit?: number; quotaDays?: number };
  };
  hideAvailable: boolean;
  hideBlocklisted: boolean;
  localLogin: boolean;
  mediaServerLogin: boolean;
  newPlexLogin: boolean;
  discoverRegion: string;
  streamingRegion: string;
  originalLanguage: string;
  blocklistRegion: string;
  blocklistLanguage: string;
  blocklistedTags: string;
  blocklistedTagsLimit: number;
  mediaServerType: number;
  partialRequestsEnabled: boolean;
  enableSpecialEpisodes: boolean;
  locale: string;
  youtubeUrl: string;
  versionCheck: boolean;
}

/**
 * Core `Permission` values, for gating a route on a core permission instead of
 * one of the extension's own.
 *
 * A frozen object of literals rather than an `enum`, for the same reason
 * {@link SeerrMediaStatus} is a union: a re-declared enum would be nominally
 * distinct from the host's. The values are the bit weights in
 * `server/lib/permissions.ts`; note bit 31 is unusable there because
 * `hasPermission` uses JS `&`.
 */
export const SeerrPermission = {
  NONE: 0,
  ADMIN: 2,
  MANAGE_SETTINGS: 4,
  MANAGE_USERS: 8,
  MANAGE_REQUESTS: 16,
  REQUEST: 32,
  VOTE: 64,
  AUTO_APPROVE: 128,
  AUTO_APPROVE_MOVIE: 256,
  AUTO_APPROVE_TV: 512,
  REQUEST_4K: 1024,
  REQUEST_4K_MOVIE: 2048,
  REQUEST_4K_TV: 4096,
  REQUEST_ADVANCED: 8192,
  REQUEST_VIEW: 16384,
  AUTO_APPROVE_4K: 32768,
  AUTO_APPROVE_4K_MOVIE: 65536,
  AUTO_APPROVE_4K_TV: 131072,
  REQUEST_MOVIE: 262144,
  REQUEST_TV: 524288,
  MANAGE_ISSUES: 1048576,
  VIEW_ISSUES: 2097152,
  CREATE_ISSUES: 4194304,
  AUTO_REQUEST: 8388608,
  AUTO_REQUEST_MOVIE: 16777216,
  AUTO_REQUEST_TV: 33554432,
  RECENT_VIEW: 67108864,
  WATCHLIST_VIEW: 134217728,
  MANAGE_BLOCKLIST: 268435456,
  VIEW_BLOCKLIST: 1073741824,
} as const;

/** The name of a core `Permission` member, as a manifest names one. */
export type SeerrPermissionName = keyof typeof SeerrPermission;

/**
 * A core permission bit. Widened to `number` rather than the union of
 * {@link SeerrPermission}'s values, because the host's parameter is the
 * `Permission` enum and a numeric enum is assignable to `number` but not to a
 * union of numeric literals.
 */
export type SeerrPermissionValue = number;
