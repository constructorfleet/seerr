/**
 * Typechecks this package against the host contract it mirrors.
 *
 * `server/lib/extensions/types.ts` is the contract; this package re-declares it
 * with the Seerr entity `type`-imports replaced by structural stand-ins (see
 * `src/entities.ts`). That re-declaration is only safe while the two agree, and
 * nothing in either file's own typecheck notices when they stop agreeing — the
 * host does not import this package, and this package deliberately does not
 * import the host.
 *
 * This file closes that gap. It is not part of the published build (it lives
 * outside `src/`, and `tsconfig.json` includes only `src/**`); it is compiled by
 * `pnpm --filter @seerr/extension-sdk conformance`, which
 * `server/lib/extensions/sdkPackage.test.ts` runs as a test. A column that
 * changes type, a capability that gains or loses its optionality, a manifest
 * field the schema adds — each fails here, in the repo, rather than in an
 * extension author's build months later.
 *
 * Nothing is exported and nothing runs. Every check is an assignability
 * assertion, so a failure is a compile error.
 */
import type { ExtensionManifest as HostManifest } from '@server/lib/extensions/manifest';
import type {
  ExtensionEventMap as HostEventMap,
  ExtensionJobs as HostJobs,
  ExtensionKvStore as HostKvStore,
  ExtensionMedia as HostMedia,
  ExtensionMediaWrite as HostMediaWrite,
  ExtensionNotificationPayload as HostNotificationPayload,
  ExtensionNotify as HostNotify,
  ExtensionRequests as HostRequests,
  ExtensionRouter as HostRouter,
  ExtensionSdk as HostSdk,
  ExtensionSettings as HostSettings,
  ExtensionStore as HostStore,
  ExtensionUsers as HostUsers,
} from '@server/lib/extensions/types';
import type { NarrowedExtensionSdk } from '../src/defineExtension';
import type { ExtensionManifest as SdkManifest } from '../src/manifest';
import type {
  ExtensionEventMap as SdkEventMap,
  ExtensionJobs as SdkJobs,
  ExtensionKvStore as SdkKvStore,
  ExtensionMedia as SdkMedia,
  ExtensionMediaWrite as SdkMediaWrite,
  ExtensionNotificationPayload as SdkNotificationPayload,
  ExtensionNotify as SdkNotify,
  ExtensionRequests as SdkRequests,
  ExtensionRouter as SdkRouter,
  ExtensionSdk as SdkSdk,
  ExtensionSettings as SdkSettings,
  ExtensionStore as SdkStore,
  ExtensionUsers as SdkUsers,
} from '../src/types';

/** `TValue` is assignable to `TTarget`, or this line is a compile error. */
type AssignableTo<TTarget, TValue extends TTarget> = TValue;

/** Fails to compile unless `T` is exactly `true`. */
type Assert<T extends true> = T;

/**
 * Whether `A` and `B` are mutually assignable.
 *
 * Written as a conditional yielding a boolean, then fed through {@link Assert},
 * rather than as a pair of constrained type parameters (`<A extends B, B extends
 * A>`) — that formulation is a circular constraint and TypeScript rejects the
 * declaration itself. The tuple wrappers stop the conditionals distributing over
 * unions, which matters for the `keyof` comparisons below.
 */
type Equivalent<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

// #region the direction that matters
//
// The host builds a real SDK and hands it to code typed against this package's
// `ExtensionSdk`, so **host-assignable-to-SDK** is the load-bearing direction.
// It is what makes the structural entity stand-ins sound: `SeerrMedia` may have
// fewer members than the real `Media`, but every member it does have must match,
// or a real `Media` is not assignable to it.

type _SdkAcceptsHostSdk = AssignableTo<SdkSdk, HostSdk>;

// Member by member as well as whole-object, because `ExtensionSdk`'s gated
// members are optional: `store?: A` accepts `store?: B` for an unrelated `B`
// only if `B` is assignable to `A`, but a *missing* member is also assignable to
// an optional one. Checking the member types directly means a stand-in that
// drifted cannot hide behind the optionality.
type _SdkAcceptsHostStore = AssignableTo<SdkStore, HostStore>;
type _SdkAcceptsHostKvStore = AssignableTo<SdkKvStore, HostKvStore>;
type _SdkAcceptsHostUsers = AssignableTo<SdkUsers, HostUsers>;
type _SdkAcceptsHostMedia = AssignableTo<SdkMedia, HostMedia>;
type _SdkAcceptsHostMediaWrite = AssignableTo<SdkMediaWrite, HostMediaWrite>;
type _SdkAcceptsHostRequests = AssignableTo<SdkRequests, HostRequests>;
type _SdkAcceptsHostSettings = AssignableTo<SdkSettings, HostSettings>;
type _SdkAcceptsHostNotify = AssignableTo<SdkNotify, HostNotify>;
type _SdkAcceptsHostJobs = AssignableTo<SdkJobs, HostJobs>;

// #endregion

// #region the direction that catches removals
//
// SDK-assignable-to-host does not have to hold for the *entity* types — the
// stand-ins are narrower on purpose. It does have to hold for the parts with no
// entity in them, where any difference at all is drift rather than design.

type _RouterIsIdentical = Assert<Equivalent<SdkRouter, HostRouter>>;
type _KvStoreIsIdentical = Assert<Equivalent<SdkKvStore, HostKvStore>>;
type _JobsIsIdentical = Assert<Equivalent<SdkJobs, HostJobs>>;

/**
 * The gated members must be optional on *both* sides, and unconditional members
 * must be optional on neither. `defineExtension`'s narrowing assumes exactly
 * this, so a capability that quietly became non-optional in the host would make
 * `NarrowedExtensionSdk` wrong rather than merely redundant.
 */
type OptionalKeys<T> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? K : never;
}[keyof T];

type _SameOptionality = Assert<
  Equivalent<OptionalKeys<SdkSdk>, OptionalKeys<HostSdk>>
>;

/** Neither side may add or drop a member outright. */
type _SameKeys = Assert<Equivalent<keyof SdkSdk, keyof HostSdk>>;

// #endregion

// #region events

/** The event names must match exactly; a payload may be structurally narrower. */
type _SameEventNames = Assert<
  Equivalent<keyof SdkEventMap, keyof HostEventMap>
>;

type _SdkAcceptsHostEventPayloads = {
  [K in keyof HostEventMap]: AssignableTo<
    SdkEventMap[K & keyof SdkEventMap],
    HostEventMap[K]
  >;
};

// #endregion

// #region notifications

type _SdkAcceptsHostNotificationPayload = AssignableTo<
  SdkNotificationPayload,
  HostNotificationPayload
>;

/**
 * A payload an extension constructs must be one the host accepts, which is why
 * this direction is checked too: `notify.send` is the one place an extension
 * passes an entity *in* rather than reading one out.
 *
 * `notifyUser` and `media` are excluded because they are the entity-typed
 * fields — an extension can only obtain those from `sdk.users.get` /
 * `sdk.media.get`, which return the real objects at runtime.
 */
type _HostAcceptsSdkNotificationPayload = AssignableTo<
  Omit<HostNotificationPayload, 'notifyUser' | 'media'>,
  Omit<SdkNotificationPayload, 'notifyUser' | 'media'>
>;

// #endregion

// #region manifest
//
// `src/manifest.ts` is a hand-written mirror of `z.infer<typeof manifestSchema>`.
// Equivalence in both directions: a field the schema adds must appear here (or
// `defineExtension` cannot narrow on it), and a field this declares that the
// schema does not have would be a `strictObject` validation failure at
// discovery — an extension that typechecked and then refused to load.

type _ManifestIsIdentical = Assert<Equivalent<SdkManifest, HostManifest>>;

// #endregion

// #region defineExtension's narrowing
//
// The claims in `NarrowedExtensionSdk`'s doc comment, as checks. These are what
// `sdkPackage.test.ts` asserts on behalf of, and they run against the host's
// `ExtensionSdk` rather than the SDK's, so the narrowing is verified to produce
// something the *host* can satisfy.

const storeManifest = {
  id: 'demo',
  name: 'Demo',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  server: 'dist/server.js',
  requires: { store: true },
} as const;

const mediaReadManifest = {
  id: 'demo',
  name: 'Demo',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  server: 'dist/server.js',
  requires: { media: 'read' },
} as const;

const mediaWriteManifest = {
  id: 'demo',
  name: 'Demo',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  server: 'dist/server.js',
  requires: { media: 'write' },
} as const;

const nothingManifest = {
  id: 'demo',
  name: 'Demo',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  server: 'dist/server.js',
} as const;

type StoreSdk = NarrowedExtensionSdk<typeof storeManifest>;
type NothingSdk = NarrowedExtensionSdk<typeof nothingManifest>;

/** `requires: { store: true }` makes `store` non-optional, not merely present. */
type _StoreIsRequired = AssignableTo<HostStore, StoreSdk['store']>;
type _StoreIsNotOptional = AssignableTo<
  never,
  OptionalKeys<StoreSdk> & 'store'
>;

/** An undeclared capability is absent, so reading it is a compile error. */
type _UsersIsAbsentWhenUndeclared = AssignableTo<
  never,
  keyof StoreSdk & 'users'
>;
type _NothingDeclaresNoCapability = AssignableTo<
  never,
  keyof NothingSdk & ('store' | 'users' | 'media' | 'requests' | 'jobs')
>;

/** The unconditional members survive narrowing, and keep their host types. */
type _RouterSurvives = AssignableTo<HostRouter, NothingSdk['router']>;
type _IdSurvives = AssignableTo<string, NothingSdk['id']>;

/**
 * A real host SDK built for `storeManifest` satisfies the narrowed type.
 *
 * This is the assertion that makes `defineExtension`'s internal cast honest: the
 * loader attaches `store` when `requires.store` is set, so a `HostSdk` with a
 * `store` is assignable to `StoreSdk`.
 */
type _HostSdkWithStoreSatisfiesNarrowed = AssignableTo<
  StoreSdk,
  HostSdk & { store: HostStore }
>;

// #endregion

// #region media access levels
//
// `media` is the one capability whose access *level* changes the type, so the
// agreement pinned here is narrower than "the member is present": `'read'` must
// not resolve to a type with `remove`, or an extension would typecheck against a
// member the loader did not attach and fail at runtime with a `TypeError`.

type MediaReadSdk = NarrowedExtensionSdk<typeof mediaReadManifest>;
type MediaWriteSdk = NarrowedExtensionSdk<typeof mediaWriteManifest>;

/** `'write'` grants `remove`, with the host's signature. */
type _WriteGrantsRemove = AssignableTo<
  HostMediaWrite['remove'],
  MediaWriteSdk['media']['remove']
>;
/**
 * Host-assignable-to-narrowed, the load-bearing direction: the host builds the
 * object and the extension consumes it through this type. The reverse does not
 * hold and must not — `SeerrMedia` is a deliberately narrower stand-in for
 * `Media`, so an SDK-typed `get` is not assignable to the host's.
 */
type _WriteSatisfiesHostWrite = AssignableTo<
  MediaWriteSdk['media'],
  HostMediaWrite
>;

/**
 * `'read'` does not. `keyof ... & 'remove'` is `never` only when the key is
 * genuinely absent, which is what makes `sdk.media.remove` a compile error rather
 * than a `possibly undefined` warning an author can `!` away.
 */
type _ReadWithholdsRemove = AssignableTo<
  never,
  keyof MediaReadSdk['media'] & 'remove'
>;

/**
 * A real host `media` object satisfies each narrowed type, which also proves
 * neither is optional — a missing member would not be assignable.
 *
 * The write case must be given the host's *write* type: a plain `HostMedia` has
 * no `remove` and is rejected here, which is the same mistake as the loader
 * attaching the read object for a `'write'` manifest.
 */
type _ReadHasLookups = AssignableTo<MediaReadSdk['media'], HostMedia>;
type _WriteHasLookups = AssignableTo<MediaWriteSdk['media'], HostMediaWrite>;

/**
 * Write access keeps the read surface — additive, not a separate mode. Asserted
 * on the *keys*, because the assignability checks above would still pass if
 * `'write'` resolved to a type that had `remove` and had dropped `findByTmdbId`.
 */
type _WriteKeepsReadKeys = Assert<
  Equivalent<
    keyof MediaReadSdk['media'] | 'remove',
    keyof MediaWriteSdk['media']
  >
>;

/**
 * A real host SDK built for `mediaWriteManifest` satisfies the narrowed type,
 * which is the assertion that makes the loader's `as ExtensionMediaWrite` cast
 * honest — it attaches `remove` on exactly this manifest.
 */
type _HostSdkWithMediaWriteSatisfiesNarrowed = AssignableTo<
  MediaWriteSdk,
  HostSdk & { media: HostMediaWrite }
>;

// #endregion
