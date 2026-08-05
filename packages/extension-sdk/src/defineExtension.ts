/**
 * `defineExtension` — the one piece of this package with a reason to exist
 * beyond re-exported types.
 *
 * `ExtensionSdk`'s capability-gated members are optional, because that is what
 * the loader hands over: an extension receives only what its manifest `requires`
 * declared. That is the right default for the host contract, but it means every
 * extension reads `sdk.store!.kv` or `sdk.store?.kv` even when its own manifest
 * two lines up guarantees `store` is there.
 *
 * With the manifest in scope as a literal type, that guarantee is recoverable.
 * See {@link NarrowedExtensionSdk} for exactly what is and is not inferred.
 */
import type { ExtensionManifestInput } from './manifestInput';
import type {
  ExtensionJobs,
  ExtensionMedia,
  ExtensionMediaWrite,
  ExtensionNotify,
  ExtensionRequests,
  ExtensionSdk,
  ExtensionSettings,
  ExtensionStore,
  ExtensionUsers,
} from './types';

/**
 * An entity class or TypeORM `EntitySchema` an extension contributes.
 *
 * Deliberately loose. The host's `ExtensionEntity` is `Function | EntitySchema`,
 * and reproducing that here would make `typeorm` a hard type dependency of this
 * module for a value this package never inspects — the loader reads
 * `getMetadataArgsStorage()` to check the table name, not this type.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export type ExtensionEntity = Function | object;

/** A TypeORM migration class an extension contributes. */
export type ExtensionMigration = new () => unknown;

/**
 * Which `ExtensionSdk` members the manifest gates. Everything else — `id`,
 * `logger`, `router`, `events` — is unconditional.
 */
type GatedMember =
  | 'store'
  | 'users'
  | 'media'
  | 'requests'
  | 'settings'
  | 'notify'
  | 'jobs';

/** Flattens an intersection so editors show one object rather than `A & B & C`. */
type Flatten<T> = { [K in keyof T]: T[K] } & {};

/**
 * The gated members a manifest declares, as a union of {@link GatedMember}.
 *
 * Written as a distributive conditional per capability rather than a mapped
 * type, because each capability is gated on a differently-shaped piece of the
 * manifest: `store` and `jobs` on a literal `true`, the data-access capabilities
 * on an access-level string, and `notify` on `provides.notifications` being
 * non-empty. That mirrors `buildSdk` in `server/lib/extensions/loader.ts`, which
 * is the behaviour this has to agree with.
 */
export type DeclaredCapability<TManifest extends ExtensionManifestInput> =
  | (TManifest extends { requires: { store: true } } ? 'store' : never)
  | (TManifest extends { requires: { jobs: true } } ? 'jobs' : never)
  | (TManifest extends { requires: { users: 'read' | 'write' } }
      ? 'users'
      : never)
  | (TManifest extends { requires: { media: 'read' | 'write' } }
      ? 'media'
      : never)
  | (TManifest extends { requires: { requests: 'read' | 'write' } }
      ? 'requests'
      : never)
  | (TManifest extends { requires: { settings: 'read' } } ? 'settings' : never)
  | (TManifest extends {
      provides: { notifications: readonly [unknown, ...unknown[]] };
    }
      ? 'notify'
      : never);

/**
 * The concrete type of each gated member, for {@link NarrowedExtensionSdk}.
 *
 * Parameterized on the manifest, because for `media` the *access level* changes
 * the type and not merely whether the member is present: `'write'` adds
 * `remove`. Everything else resolves the same for `'read'` and `'write'` — those
 * capabilities have no write member yet, and when one gains one it becomes a
 * second entry that reads `TManifest` the way `media` does here.
 */
interface GatedMemberType<TManifest extends ExtensionManifestInput> {
  store: ExtensionStore;
  users: ExtensionUsers;
  media: TManifest extends { requires: { media: 'write' } }
    ? ExtensionMediaWrite
    : ExtensionMedia;
  requests: ExtensionRequests;
  settings: ExtensionSettings;
  notify: ExtensionNotify;
  jobs: ExtensionJobs;
}

/**
 * `ExtensionSdk` with the capabilities `TManifest` declares made non-optional,
 * and the ones it does not declare **removed**.
 *
 * ## What this infers
 *
 * - `requires: { store: true }` → `sdk.store` is `ExtensionStore`, not
 *   `ExtensionStore | undefined`. Same for `requires: { jobs: true }`.
 * - `requires: { users: 'read' }` (or `'write'`) → `sdk.users` is present. Same
 *   for `media`, `requests`, and `settings: 'read'`.
 * - **The access level, for `media`.** `requires: { media: 'read' }` gives
 *   `ExtensionMedia`; `'write'` gives `ExtensionMediaWrite`, which adds
 *   `remove`. So `sdk.media.remove(id)` under `'read'` is `Property 'remove'
 *   does not exist`, matching the host, which attaches `remove` only for
 *   `'write'`. `users` and `requests` accept both levels but have no write
 *   member yet, so for those the level currently has no type-level consequence —
 *   deliberately, rather than by oversight.
 * - `provides: { notifications: [...] }` with at least one entry → `sdk.notify`
 *   is present, matching the loader, which gates `notify` on the manifest
 *   *providing* a notification type rather than on `requires`.
 * - Anything not declared is **absent from the type**, so reading it is
 *   `Property 'users' does not exist`. That is the point: an optional member
 *   only converts a forgotten `requires.users` from a runtime `TypeError` into a
 *   silent `sdk.users?.get(id)` that never runs. Absent makes it a compile
 *   error, which is what `types.ts` says optional was for.
 *
 * ## What this does not infer
 *
 * - **`requires: { store: false }`** is treated as undeclared, correctly — but
 *   note the loader tests truthiness, so `store: false` and an absent `store`
 *   behave identically at runtime too.
 * - **Nothing about permission or job keys.** `sdk.jobs.register('sync', fn)`
 *   is not checked against `provides.jobs[].id`, and a route's
 *   `permission: 'view_own'` is not checked against
 *   `provides.permissions[].key`. Both *are* enforced at runtime — the loader
 *   throws on an undeclared job id, and `notify.send` throws on an undeclared
 *   notification key. Threading those literal unions through
 *   `ExtensionRouteOptions` and `ExtensionJobs` would mean parameterizing the
 *   whole `ExtensionSdk` on the manifest, which changes the host contract in
 *   `server/lib/extensions/types.ts` for a check the runtime already makes.
 *   Deliberately left out.
 * - **`http`, `version`, `apiVersion`, `id`.** No type-level consequence.
 * - **A manifest that is not a literal.** If `TManifest` is the wide
 *   `ExtensionManifest` (because the object was annotated `: ExtensionManifest`
 *   rather than passed inline), every conditional above resolves to `never` and
 *   no capability is inferred. Annotate with `satisfies ExtensionManifest`
 *   instead of `:`, or pass the object literal directly to `defineExtension`.
 */
export type NarrowedExtensionSdk<TManifest extends ExtensionManifestInput> =
  Flatten<
    Omit<ExtensionSdk, GatedMember> & {
      [K in DeclaredCapability<TManifest> &
        GatedMember]-?: GatedMemberType<TManifest>[K];
    }
  >;

/** What {@link defineExtension} is given. */
export interface ExtensionDefinition<TManifest extends ExtensionManifestInput> {
  /**
   * This extension's `seerr-extension.json`, imported or inlined.
   *
   * Only used for its *type*: the host reads the real file from disk at
   * discovery, and never consults this value. Keeping the two in agreement is
   * the author's job — importing the JSON (`import manifest from
   * '../seerr-extension.json'`) makes that automatic.
   */
  manifest: TManifest;
  /** The entry point body, receiving the narrowed SDK. */
  setup: (sdk: NarrowedExtensionSdk<TManifest>) => void | Promise<void>;
  /**
   * Entity classes or `EntitySchema`s, every one mapping to a table named
   * `ext_<id>_*`. Read during discovery, **before** the DataSource is
   * initialized, because TypeORM cannot register an entity after
   * `initialize()`.
   */
  entities?: readonly ExtensionEntity[];
  /** Migrations, run in their own `ext_<id>_migration` tracking table. */
  migrations?: readonly ExtensionMigration[];
}

/**
 * The module shape the host's loader reads from an extension's `server` entry
 * point: a `default` setup function, plus the `entities` and `migrations` it
 * needs before the DataSource exists.
 */
export interface ExtensionModule<TManifest extends ExtensionManifestInput> {
  default: (sdk: ExtensionSdk) => void | Promise<void>;
  entities: readonly ExtensionEntity[];
  migrations: readonly ExtensionMigration[];
  /** Carried through for an extension's own use; the host ignores it. */
  manifest: TManifest;
}

/**
 * Declares an extension, narrowing the SDK its `setup` receives to the
 * capabilities its manifest declares.
 *
 * The return value **is** the module the loader expects, so an entry point ends
 * with it:
 *
 * ```ts
 * import { defineExtension } from '@seerr/extension-sdk';
 * import manifest from '../seerr-extension.json';
 *
 * export = defineExtension({
 *   manifest,
 *   entities: [WatchEvent],
 *   setup(sdk) {
 *     // `store` is non-optional here, because the manifest requires it
 *     sdk.router.get('/history', {}, async (_req, res) => {
 *       res.json(await sdk.store.getRepository(WatchEvent).find());
 *     });
 *   },
 * });
 * ```
 *
 * `export =` rather than `export default`, because the loader reads
 * `module.exports.default` for the setup function and `module.exports.entities`
 * for the entities — `export default defineExtension(...)` would nest them one
 * level too deep, putting an object where the loader looks for a function.
 */
export function defineExtension<const TManifest extends ExtensionManifestInput>(
  definition: ExtensionDefinition<TManifest>
): ExtensionModule<TManifest> {
  return {
    // The cast is the one place the narrowing is taken on faith, and it is the
    // host that makes it true: `buildSdk` reads the same manifest to decide
    // which members to attach, so an SDK built for this manifest does have
    // whatever `NarrowedExtensionSdk` claims. Unsound only if the manifest
    // passed here disagrees with the `seerr-extension.json` on disk, which is
    // also the case that makes the extension's runtime behaviour wrong.
    default: definition.setup as (sdk: ExtensionSdk) => void | Promise<void>,
    entities: definition.entities ?? [],
    migrations: definition.migrations ?? [],
    manifest: definition.manifest,
  };
}
