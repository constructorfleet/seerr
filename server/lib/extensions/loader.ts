import TautulliAPI from '@server/api/tautulli';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieResult,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import { MediaType } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import { ExtensionKv } from '@server/entity/ExtensionKv';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import type { ExtensionManifest } from '@server/lib/extensions/manifest';
import { parseManifest } from '@server/lib/extensions/manifest';
import {
  extensionTablePrefix,
  runExtensionMigrations,
} from '@server/lib/extensions/migrations';
import { extensionHasPermission } from '@server/lib/extensions/permissions';
import type {
  ExtensionEntity,
  ExtensionEntry,
  ExtensionRouteMethod,
} from '@server/lib/extensions/registry';
import {
  ExtensionRegistrations,
  ExtensionRegistry,
  declaredJob,
} from '@server/lib/extensions/registry';
import { getExtensionSettingValues } from '@server/lib/extensions/settingValues';
import type {
  ExtensionDiscover,
  ExtensionDiscoverMediaType,
  ExtensionEvent,
  ExtensionKvStore,
  ExtensionMedia,
  ExtensionMediaDetails,
  ExtensionMediaWrite,
  ExtensionNotificationPayload,
  ExtensionNotify,
  ExtensionPermissionKey,
  ExtensionRequests,
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
} from '@server/lib/extensions/types';
import { removeMediaFromServarr } from '@server/lib/mediaRemoval';
import type { Permission } from '@server/lib/permissions';
import type { MainSettings, TautulliSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import fs from 'fs/promises';
import path from 'path';
import semver from 'semver';
import type { DataSource, DataSourceOptions, MixedList } from 'typeorm';
import {
  DataSource as DataSourceCtor,
  InstanceChecker,
  getMetadataArgsStorage,
} from 'typeorm';

/**
 * The SDK version this host implements. An extension declares a semver *range*
 * in its manifest `apiVersion`; a range this does not satisfy refuses the
 * extension at discovery rather than letting it fail somewhere less legible.
 */
export const HOST_API_VERSION = '1.0.0';

/**
 * Exported because install validates the same file discovery reads: a package
 * whose manifest is missing or invalid is refused at install time rather than
 * quarantined on the next boot.
 */
export const MANIFEST_FILENAME = 'seerr-extension.json';

/**
 * Where installs land: `${CONFIG_DIRECTORY:-config}/extensions/<id>/`, never
 * Seerr's own `node_modules`.
 */
export function extensionsDirectory(): string {
  return process.env.CONFIG_DIRECTORY
    ? path.join(process.env.CONFIG_DIRECTORY, 'extensions')
    : path.join(__dirname, '../../../config/extensions');
}

/**
 * The module an extension's `server` entry point exports.
 *
 * `entities` and `migrations` are read during discovery, before the DataSource
 * is initialized, which is why they are module exports rather than something the
 * entry point registers through the SDK — by the time the entry point runs, the
 * DataSource's metadata is already built and immutable.
 */
interface ExtensionModule {
  default?: ExtensionSetup;
  entities?: MixedList<ExtensionEntity>;
  migrations?: MixedList<new () => unknown>;
}

export interface DiscoverExtensionsOptions {
  /** Defaults to {@link extensionsDirectory}. Injectable for tests. */
  directory?: string;
  /**
   * Whether the operator has this extension switched on. Defaults to enabling
   * everything present; slice 8 supplies the persisted setting.
   */
  isEnabled?: (id: string, manifest: ExtensionManifest) => boolean;
}

/**
 * **Phase A.** Reads every installed extension's manifest and module, with no
 * database access at all, and returns the registry whose `entities` must be
 * injected into the DataSource before `initialize()`.
 *
 * Every failure mode — unreadable directory, unparseable or invalid manifest,
 * directory/id disagreement, apiVersion mismatch, a module that throws on
 * `require` — quarantines that one extension and leaves the rest alone. Nothing
 * here rejects.
 */
export async function discoverExtensions(
  options: DiscoverExtensionsOptions = {}
): Promise<ExtensionRegistry> {
  const directory = options.directory ?? extensionsDirectory();
  const registry = new ExtensionRegistry();
  const candidates = await readCandidates(directory);

  for (const id of candidates) {
    await discoverOne(registry, path.join(directory, id), id, options);
  }

  return registry;
}

/**
 * Directory names under `directory`, or none if it does not exist — nothing is
 * installed at boot, so an absent directory is the default state, not an error.
 */
async function readCandidates(directory: string): Promise<string[]> {
  try {
    const dirents = await fs.readdir(directory, { withFileTypes: true });

    return dirents
      .filter((dirent) => dirent.isDirectory() || dirent.isSymbolicLink())
      .map((dirent) => dirent.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      logger.error('Failed to read the extensions directory', {
        label: 'Extensions',
        directory,
        errorMessage: e.message,
      });
    }

    return [];
  }
}

async function discoverOne(
  registry: ExtensionRegistry,
  directory: string,
  id: string,
  options: DiscoverExtensionsOptions
): Promise<void> {
  let raw: string;

  try {
    raw = await fs.readFile(path.join(directory, MANIFEST_FILENAME), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      // A directory that never claimed to be an extension. Silent, so an
      // operator's stray folder is not reported as a broken install.
      return;
    }

    registry.add(pendingEntry(id, directory));
    registry.fail(id, e, 'reading its manifest');
    return;
  }

  const entry = pendingEntry(id, directory);
  registry.add(entry);

  let manifest: ExtensionManifest;

  try {
    manifest = parseManifest(JSON.parse(raw));
  } catch (e) {
    registry.fail(id, e, 'validating its manifest');
    return;
  }

  if (manifest.id !== id) {
    // The directory name is what namespaces tables, routes and permissions on
    // disk, so a disagreement is ambiguous rather than cosmetic.
    registry.fail(
      id,
      new Error(
        `manifest id "${manifest.id}" does not match its directory name "${id}"`
      ),
      'checking its identity'
    );
    return;
  }

  entry.manifest = manifest;

  if (!(options.isEnabled?.(id, manifest) ?? true)) {
    entry.status = 'disabled';
    logger.info(`Skipping disabled extension "${id}"`, {
      label: 'Extensions',
    });
    return;
  }

  if (!semver.satisfies(HOST_API_VERSION, manifest.apiVersion)) {
    registry.fail(
      id,
      new Error(
        `requires host API "${manifest.apiVersion}", but this Seerr provides ${HOST_API_VERSION}`
      ),
      'checking its API version'
    );
    return;
  }

  let extensionModule: ExtensionModule;

  try {
    extensionModule = await loadModule(directory, manifest);
  } catch (e) {
    registry.fail(id, e, 'loading its entry point');
    return;
  }

  try {
    entry.entities = collectEntities(id, extensionModule);
    entry.migrations = toArray(extensionModule.migrations);
    entry.setup = resolveSetup(extensionModule);
  } catch (e) {
    registry.fail(id, e, 'reading its declarations');
    entry.entities = [];
    entry.migrations = [];
    return;
  }

  logger.info(`Discovered extension "${id}" ${manifest.version}`, {
    label: 'Extensions',
  });
}

function pendingEntry(id: string, directory: string): ExtensionEntry {
  return {
    id,
    directory,
    status: 'pending',
    entities: [],
    migrations: [],
  };
}

async function loadModule(
  directory: string,
  manifest: ExtensionManifest
): Promise<ExtensionModule> {
  const entryPath = path.join(directory, manifest.server);

  try {
    await fs.access(entryPath);
  } catch {
    throw new Error(`entry point "${manifest.server}" does not exist`);
  }

  // Extensions are trusted code — `require`d into this process, sharing its
  // TypeORM entities. See docs/specs/extension-system.md, "Trust model".
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(entryPath) as ExtensionModule;
}

function resolveSetup(loaded: ExtensionModule): ExtensionSetup {
  const setup =
    typeof loaded === 'function' ? (loaded as ExtensionSetup) : loaded.default;

  if (typeof setup !== 'function') {
    throw new Error(
      'entry point has no default export; it must default-export (sdk) => void | Promise<void>'
    );
  }

  return setup;
}

/**
 * The extension's entity classes, refused unless every one of them maps to a
 * table inside the extension's own `ext_<id>_` namespace.
 *
 * Same best-effort spirit as the migration runner's prefix check: an extension
 * could register an entity through a raw `require('@server/datasource')`. What
 * this catches is the realistic mistake of an unprefixed `@Entity({ name })`
 * colliding with — or shadowing — a core table.
 */
function collectEntities(
  id: string,
  loaded: ExtensionModule
): ExtensionEntity[] {
  const prefix = extensionTablePrefix(id);
  const entities = toArray(loaded.entities);

  for (const entity of entities) {
    const table = tableNameOf(entity);

    if (!table) {
      throw new Error(
        'exports an entity that is not a decorated class or EntitySchema with an explicit table name'
      );
    }

    if (!table.startsWith(prefix)) {
      throw new Error(
        `exports an entity for table "${table}", which is outside its "${prefix}" namespace`
      );
    }
  }

  return entities;
}

function tableNameOf(entity: ExtensionEntity): string | undefined {
  if (typeof entity === 'string') {
    // A glob or path, which would have the DataSource load whatever it matches:
    // there is no name to check until it has already been loaded.
    return undefined;
  }

  if (InstanceChecker.isEntitySchema(entity)) {
    return entity.options.tableName ?? entity.options.name;
  }

  return getMetadataArgsStorage().tables.find(
    (table) => table.target === entity
  )?.name;
}

/**
 * Appends the discovered entities to `target`'s `entities` option.
 *
 * Must run before `initialize()`: `DataSource.entityMetadatas` is readonly and
 * built during initialization, so an entity registered later never gets
 * metadata. `setOptions` is the documented way in.
 */
export function injectExtensionEntities(
  target: DataSource,
  registry: ExtensionRegistry
): void {
  const entities = registry.entities;

  if (!entities.length) {
    return;
  }

  target.setOptions({
    entities: [...toArray(target.options.entities), ...entities],
  } as Partial<DataSourceOptions>);
}

/**
 * Quarantines every extension whose entities TypeORM cannot build metadata for,
 * so that {@link injectExtensionEntities} only ever hands the real DataSource
 * entities that will survive its `initialize()`.
 *
 * `collectEntities` checks the table *name*, which is all it can do without a
 * DataSource; it cannot tell that an entity has no primary column or points a
 * relation at a target nothing declares. Those only surface when the metadata
 * builder runs — and the one that runs at boot is the real `initialize()`, which
 * `server/index.ts` cannot recover from: it takes the whole server down and the
 * operator cannot switch the extension off through an admin UI that never starts.
 * See docs/specs/extension-system.md, "one bad extension bricking a server is the
 * worst failure mode here".
 *
 * So each extension's entities are built once, in isolation, in a throwaway
 * DataSource that is never connected — `buildMetadatas` needs a driver, not a
 * database, so this costs no I/O. Per extension rather than all at once, because
 * the point is to attribute the failure to one extension and keep its neighbours.
 * Core's entities go in alongside, since an extension may legitimately relate to
 * a core entity and would otherwise fail for the wrong reason.
 */
export async function validateExtensionEntities(
  registry: ExtensionRegistry,
  baseOptions: DataSourceOptions
): Promise<void> {
  const candidates = registry
    .all()
    .filter(
      (entry) =>
        (entry.status === 'pending' || entry.status === 'active') &&
        entry.entities.length
    );

  for (const entry of candidates) {
    try {
      await buildMetadataOnly(baseOptions, entry.entities);
    } catch (e) {
      registry.fail(entry.id, e, 'building metadata for its entities');
      // Dropped so `registry.entities` cannot offer them again, mirroring the
      // `collectEntities` failure path in `discoverOne`.
      entry.entities = [];
    }
  }
}

async function buildMetadataOnly(
  baseOptions: DataSourceOptions,
  entities: ExtensionEntity[]
): Promise<void> {
  const probe = new DataSourceCtor({
    ...baseOptions,
    entities: [...toArray(baseOptions.entities), ...entities],
    // Nothing that could touch the database or the filesystem: this only wants
    // the metadata builder's verdict.
    subscribers: [],
    migrations: [],
    synchronize: false,
    dropSchema: false,
    migrationsRun: false,
  } as DataSourceOptions);

  // Reaches past the public API on purpose. `initialize()` would connect, and
  // for the main sqlite database at boot that means opening it twice; there is
  // no supported way to ask TypeORM to build metadata alone.
  await (
    probe as unknown as { buildMetadatas(): Promise<void> }
  ).buildMetadatas();
}

export interface ActivateExtensionsOptions {
  /**
   * Connection options for extension migrations. Defaults to the main
   * DataSource's, which is what production wants.
   */
  migrationBaseOptions?: DataSourceOptions;
  /**
   * Whether to run extension migrations. Defaults to true.
   *
   * Pass `false` when the main DataSource has `synchronize: true` (dev and
   * test), where it has already created the extension's tables from the entities
   * discovery injected — the migrations would then fail against tables that
   * already exist and quarantine the extension on every boot.
   */
  runMigrations?: boolean;
  /**
   * Backs `sdk.users.hasPermission`. Defaults to
   * {@link extensionHasPermission}, which applies the namespaced resolution
   * rules; injectable for tests.
   */
  hasPermission?: (
    extensionId: string,
    userId: number,
    permission: ExtensionPermissionKey | Permission
  ) => Promise<boolean>;
  /** Backs `sdk.settings.main`, before redaction. */
  getMainSettings?: () => MainSettings;
  /** Backs `sdk.settings.tautulli`, before redaction. */
  getTautulliSettings?: () => TautulliSettings;
  /**
   * Backs `sdk.settings.own`. Defaults to
   * {@link getExtensionSettingValues}, which applies the manifest's declared
   * defaults; injectable for tests.
   */
  getSettingValues?: (
    extensionId: string
  ) => Record<string, ExtensionSettingValue>;
  /**
   * Backs `sdk.notify.send`. Defaults to logging and dropping, so a loader test
   * needs no notification agents; boot passes
   * {@link sendExtensionNotification}, which resolves subscribers and dispatches
   * through `notificationManager`.
   */
  sendNotification?: (
    extensionId: string,
    key: string,
    payload: ExtensionNotificationPayload
  ) => Promise<void>;
}

/**
 * **Phase B.** Runs each discovered extension's pending migrations, then builds
 * its capability-gated SDK and calls its entry point.
 *
 * Must run after `dataSource.initialize()`, since the SDK hands out live
 * repositories. Sequential, one extension at a time, so a slow entry point is
 * legible in the log and sqlite writers do not contend.
 *
 * Never rejects: an extension that throws is quarantined and its registrations
 * discarded, and its neighbours still activate.
 */
export async function activateExtensions(
  registry: ExtensionRegistry,
  options: ActivateExtensionsOptions = {}
): Promise<void> {
  const pending = registry.all().filter((entry) => entry.status === 'pending');

  if (!pending.length) {
    return;
  }

  await migrate(registry, pending, options);

  for (const entry of pending) {
    if (entry.status !== 'pending') {
      continue;
    }

    const registrations = new ExtensionRegistrations();

    try {
      await entry.setup?.(buildSdk(entry, registrations, options));
      registry.commit(entry, registrations);
      logger.info(`Activated extension "${entry.id}"`, {
        label: 'Extensions',
      });
    } catch (e) {
      // `registrations` is dropped on the floor, so a half-registered extension
      // contributes no routes, jobs or listeners.
      registry.fail(entry.id, e, 'running its entry point');
    }
  }
}

async function migrate(
  registry: ExtensionRegistry,
  pending: ExtensionEntry[],
  options: ActivateExtensionsOptions
): Promise<void> {
  const withMigrations = pending.filter((entry) => entry.migrations.length);

  if (options.runMigrations === false || !withMigrations.length) {
    return;
  }

  const results = await runExtensionMigrations(
    withMigrations.map((entry) => ({
      id: entry.id,
      migrations: entry.migrations,
    })),
    options.migrationBaseOptions
      ? { baseOptions: options.migrationBaseOptions }
      : {}
  );

  for (const result of results) {
    if (result.error) {
      registry.fail(result.id, result.error, 'running its migrations');
    }
  }
}

/**
 * The SDK object for one extension, with exactly the capabilities its manifest
 * `requires` asked for.
 *
 * Capability hygiene, not a security boundary: extension code runs in this
 * process and can reach anything it imports directly. Withholding `sdk.users`
 * from an extension that never declared `requires.users` makes the manifest an
 * honest description of what the extension touches — it does not prevent it
 * touching more.
 */
function buildSdk(
  entry: ExtensionEntry,
  registrations: ExtensionRegistrations,
  options: ActivateExtensionsOptions
): ExtensionSdk {
  const requires = entry.manifest?.requires ?? {};
  const notifications = entry.manifest?.provides?.notifications ?? [];
  const settings = entry.manifest?.provides?.settings ?? [];

  return {
    id: entry.id,
    logger: logger.child({ label: `Extension:${entry.id}` }),
    router: buildRouter(entry.id, registrations),
    events: {
      on: (event, fn) =>
        registrations.listeners.push({
          event: event as ExtensionEvent,
          listener: {
            extensionId: entry.id,
            fn: fn as (payload: never) => void | Promise<void>,
          },
        }),
    },
    ...(requires.store ? { store: buildStore(entry.id) } : {}),
    ...(requires.users ? { users: buildUsers(entry.id, options) } : {}),
    // The only capability whose *access level* changes what is attached. `users`
    // and `requests` accept `'read' | 'write'` too, but neither has a write
    // member yet, so both levels legitimately grant the same object; when one
    // gains a mutating member it must gate on the level here the same way rather
    // than adding it unconditionally.
    ...(requires.media
      ? { media: buildMedia(entry.id, requires.media === 'write') }
      : {}),
    ...(requires.requests ? { requests: buildRequests() } : {}),
    ...(requires.discover ? { discover: buildDiscover(entry.id) } : {}),
    // Two conditions, unlike every other capability: the manifest has to declare
    // it *and* the operator has to have configured Tautulli. `buildTautulli`
    // returns `undefined` for the latter, so an extension can feature-detect a
    // missing watch-history source instead of calling `undefined:undefined`.
    ...(requires.tautulli
      ? optionalMember('tautulli', buildTautulli(entry.id, options))
      : {}),
    // Attached for either reason: `requires.settings` asks for core's settings,
    // and `provides.settings` means the extension has its own values to read.
    ...(requires.settings || settings.length
      ? {
          settings: buildSettings(
            entry.id,
            requires.settings === 'read',
            options
          ),
        }
      : {}),
    ...(requires.jobs
      ? {
          jobs: {
            register: (id, fn) => {
              const job = declaredJob(entry.manifest, id);

              if (!job) {
                throw new Error(
                  `registered job "${id}", which its manifest does not declare`
                );
              }

              registrations.jobs.push({
                extensionId: entry.id,
                id,
                name: job.name,
                schedule: job.schedule,
                run: fn,
              });
            },
          },
        }
      : {}),
    ...(notifications.length
      ? {
          notify: buildNotify(
            entry.id,
            notifications.map((notification) => notification.key),
            options
          ),
        }
      : {}),
  };
}

function buildRouter(
  extensionId: string,
  registrations: ExtensionRegistrations
): ExtensionRouter {
  const register =
    (method: ExtensionRouteMethod): ExtensionRouter[ExtensionRouteMethod] =>
    (routePath, routeOptions, handler) =>
      registrations.routes.push({
        extensionId,
        method,
        path: routePath,
        options: routeOptions,
        handler: handler as never,
      });

  return {
    get: register('get'),
    post: register('post'),
    put: register('put'),
    delete: register('delete'),
  };
}

function buildStore(extensionId: string): ExtensionStore {
  return {
    dataSource,
    getRepository: (target) => dataSource.getRepository(target),
    kv: buildKv(extensionId),
  };
}

/**
 * `sdk.store.kv`, over the shared `ext_kv` table. Rows are keyed by
 * `extensionId`, and the SDK never lets an extension name another's.
 */
function buildKv(extensionId: string): ExtensionKvStore {
  const repository = () => getRepository(ExtensionKv);

  return {
    get: async <T>(key: string) => {
      const row = await repository().findOne({ where: { extensionId, key } });

      return row ? (row.value as T) : null;
    },
    set: async (key, value) => {
      await repository().save(new ExtensionKv({ extensionId, key, value }));
    },
    delete: async (key) => {
      await repository().delete({ extensionId, key });
    },
    list: async (prefix) => {
      // Filtered here rather than with a `LIKE`, because a caller's prefix is
      // not an escaped pattern and this table holds small state by design.
      const rows = await repository().find({
        where: { extensionId },
        select: { key: true },
      });

      return rows
        .map((row) => row.key)
        .filter((key) => !prefix || key.startsWith(prefix))
        .sort((a, b) => a.localeCompare(b));
    },
  };
}

function buildUsers(
  extensionId: string,
  options: ActivateExtensionsOptions
): ExtensionUsers {
  return {
    get: (id) => getRepository(User).findOne({ where: { id } }),
    // `extensionId` is passed through so an extension can ask about its own
    // manifest key without namespacing it, e.g. `hasPermission(id, 'view_own')`.
    hasPermission: (userId, permission) =>
      (options.hasPermission ?? extensionHasPermission)(
        extensionId,
        userId,
        permission
      ),
  };
}

/**
 * `sdk.media`, with the destructive members attached only for write access.
 *
 * Spread onto the read object rather than returned from two branches, so `get`
 * and `findByTmdbId` have one implementation and a read-only extension's object
 * genuinely lacks the `remove` key — `'remove' in sdk.media` is false, not
 * present-and-undefined, which is the difference between a capability an
 * extension can feature-detect and one that fails on call.
 *
 * Returns the write type because `ExtensionSdk.media` is declared that way — the
 * host contract has no manifest to narrow against, so it types the superset and
 * leaves the narrowing to `defineExtension`. The cast is the price of that, and
 * it is confined to this one function: `canWrite` is derived from the same
 * manifest field the SDK package narrows on, so the two cannot disagree without
 * the conformance check noticing.
 */
function buildMedia(
  extensionId: string,
  canWrite: boolean
): ExtensionMediaWrite {
  const media: ExtensionMedia = {
    get: (id) => getRepository(Media).findOne({ where: { id } }),
    findByTmdbId: (tmdbId, mediaType) =>
      getRepository(Media).findOne({ where: { tmdbId, mediaType } }),
    // Guarded rather than passed straight through: TypeORM turns a two-clause
    // `where` on an empty string into `ratingKey = '' OR ratingKey4k = ''`,
    // which matches nothing — but an *undefined* key would drop the clause and
    // match an arbitrary row, so the empty case is refused here where it is
    // visible instead of relying on that.
    findByRatingKey: async (ratingKey) =>
      ratingKey
        ? ((await getRepository(Media).findOne({
            where: [{ ratingKey }, { ratingKey4k: ratingKey }],
          })) ?? null)
        : null,
    getDetails: buildMediaGetDetails(extensionId),
    ...(canWrite ? { remove: buildMediaRemove(extensionId) } : {}),
  };

  return media as ExtensionMediaWrite;
}

/**
 * The size TMDB paths are requested at, matching what core's own components ask
 * for so the operator's image cache is shared rather than doubled.
 */
const POSTER_SIZE = 'w600_and_h900_bestv2';
const BACKDROP_SIZE = 'w1920_and_h800_multi_faces';

/**
 * Turns a TMDB image path into a URL a browser can use.
 *
 * The `cacheImages` rewriting lives here, on the server, for the same reason the
 * whole of `getDetails` does: an extension is a backend, and the alternative is
 * every panel carrying a copy of the proxy rule — so an operator who turned
 * `cacheImages` on to stop the browser talking to tmdb.org would find one
 * extension still doing it.
 *
 * `/imageproxy/tmdb/...` is a host route (`server/index.ts`), served above the
 * OpenAPI validator and outside `/api/v1`, so this URL is directly fetchable and
 * needs nothing from the extension.
 */
function tmdbImageUrl(path: string | null | undefined, size: string) {
  if (!path) {
    return null;
  }

  return getSettings().main.cacheImages
    ? `/imageproxy/tmdb/t/p/${size}${path}`
    : `https://image.tmdb.org/t/p/${size}${path}`;
}

/**
 * `sdk.media.getDetails`: displayable metadata for a core media row.
 *
 * Two lookups — core's row for the tmdbId and type, then TMDB for the title —
 * because an extension stores a media id, not a tmdbId, and translating between
 * them is exactly the kind of thing it should not have to know.
 *
 * A TMDB failure is logged and answered `null` rather than thrown. The caller is
 * typically decorating a response it could serve without this (a list of requests
 * that already has its ids), so propagating would turn a metadata outage into a
 * broken extension route. `null` also covers "no such media", and the doc comment
 * says so: both mean "nothing to display", which is the only distinction a
 * renderer acts on.
 */
function buildMediaGetDetails(
  extensionId: string
): ExtensionMedia['getDetails'] {
  return async (id) => {
    const media = await getRepository(Media).findOne({ where: { id } });

    if (!media) {
      return null;
    }

    const tmdb = new TheMovieDb();

    try {
      if (media.mediaType === MediaType.MOVIE) {
        const movie = await tmdb.getMovie({ movieId: media.tmdbId });

        return {
          tmdbId: media.tmdbId,
          mediaType: media.mediaType,
          title: movie.title,
          year: yearOf(movie.release_date),
          overview: movie.overview ?? '',
          posterUrl: tmdbImageUrl(movie.poster_path, POSTER_SIZE),
          backdropUrl: tmdbImageUrl(movie.backdrop_path, BACKDROP_SIZE),
        };
      }

      const tv = await tmdb.getTvShow({ tvId: media.tmdbId });

      return {
        tmdbId: media.tmdbId,
        mediaType: media.mediaType,
        title: tv.name,
        year: yearOf(tv.first_air_date),
        overview: tv.overview ?? '',
        posterUrl: tmdbImageUrl(tv.poster_path, POSTER_SIZE),
        backdropUrl: tmdbImageUrl(tv.backdrop_path, BACKDROP_SIZE),
      };
    } catch (e) {
      logger.warn('Extension could not read media details', {
        label: 'Extensions',
        extensionId,
        mediaId: id,
        tmdbId: media.tmdbId,
        errorMessage: e instanceof Error ? e.message : String(e),
      });

      return null;
    }
  };
}

/** A four-digit year from a TMDB date, which may be absent or an empty string. */
function yearOf(date: string | null | undefined): number | null {
  const year = Number((date ?? '').slice(0, 4));

  return Number.isInteger(year) && year > 0 ? year : null;
}

/**
 * The fields of a TMDB search/trending result this maps into
 * {@link ExtensionMediaDetails}.
 *
 * Structural rather than TMDB's own `TmdbMovieResult | TmdbTvResult`, because
 * one mapper serves both types and both shapes: `title`/`release_date` for a
 * movie, `name`/`first_air_date` for a series. Everything is optional, since the
 * recommendation endpoints omit `media_type` entirely and any field may be
 * absent for an obscure title.
 */
interface TmdbResultish {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
}

/**
 * One TMDB list entry as {@link ExtensionMediaDetails}.
 *
 * `mediaType` is passed in rather than read from `media_type`: only the
 * multi-type endpoints (`/trending/all`) set it, and the per-type ones
 * (`/movie/:id/similar`) answer a single type and omit it. Trusting the payload
 * would leave every recommendation with an undefined type.
 */
function detailsFromTmdbResult(
  result: TmdbResultish,
  mediaType: ExtensionDiscoverMediaType
): ExtensionMediaDetails {
  const isMovie = mediaType === 'movie';

  return {
    tmdbId: result.id,
    mediaType: isMovie ? MediaType.MOVIE : MediaType.TV,
    title: (isMovie ? result.title : result.name) ?? '',
    year: yearOf(isMovie ? result.release_date : result.first_air_date),
    overview: result.overview ?? '',
    posterUrl: tmdbImageUrl(result.poster_path, POSTER_SIZE),
    backdropUrl: tmdbImageUrl(result.backdrop_path, BACKDROP_SIZE),
  };
}

/**
 * `sdk.discover`: TMDB lookups an extension makes through *core's* client.
 *
 * The reason this exists rather than an extension shipping its own TMDB key:
 * core's client shares one `nodeCache` and one rate limiter (20 requests / 50
 * RPS) across the whole process. A second key inside an extension would share
 * neither, so the operator's budget would be spent twice and the limiter would
 * no longer be protecting them — and an *example* extension doing that would
 * teach every other extension author the same mistake.
 *
 * Every member logs and resolves `[]` on failure, matching `getDetails`
 * resolving `null`: the caller is decorating a response it could serve without
 * this, and "nothing to suggest" is the only distinction a renderer acts on.
 */
function buildDiscover(extensionId: string): ExtensionDiscover {
  /** One `try` for all three members, so the failure contract is written once. */
  const attempt = async (
    what: string,
    fetch: (tmdb: TheMovieDb) => Promise<ExtensionMediaDetails[]>
  ): Promise<ExtensionMediaDetails[]> => {
    try {
      return await fetch(new TheMovieDb());
    } catch (e) {
      logger.warn('Extension could not reach TMDB', {
        label: 'Extensions',
        extensionId,
        lookup: what,
        errorMessage: e instanceof Error ? e.message : String(e),
      });

      return [];
    }
  };

  return {
    trending: ({ timeWindow = 'week', page = 1 } = {}) =>
      attempt('trending', async (tmdb) => {
        const { results } = await tmdb.getAllTrending({ timeWindow, page });

        // `person` and `collection` are dropped rather than mapped: neither is a
        // title an extension can suggest, and neither has the fields
        // `ExtensionMediaDetails` promises.
        return results
          .filter(
            (result): result is TmdbMovieResult | TmdbTvResult =>
              result.media_type === 'movie' || result.media_type === 'tv'
          )
          .map((result) =>
            detailsFromTmdbResult(result, result.media_type as 'movie' | 'tv')
          );
      }),
    recommendations: (tmdbId, mediaType, { page = 1 } = {}) =>
      attempt('recommendations', async (tmdb) => {
        const { results } =
          mediaType === 'movie'
            ? await tmdb.getMovieRecommendations({ movieId: tmdbId, page })
            : await tmdb.getTvRecommendations({ tvId: tmdbId, page });

        return results.map((result) =>
          detailsFromTmdbResult(result, mediaType)
        );
      }),
    similar: (tmdbId, mediaType, { page = 1 } = {}) =>
      attempt('similar', async (tmdb) => {
        const { results } =
          mediaType === 'movie'
            ? await tmdb.getMovieSimilar({ movieId: tmdbId, page })
            : await tmdb.getTvSimilar({ tvId: tmdbId, page });

        return results.map((result) =>
          detailsFromTmdbResult(result, mediaType)
        );
      }),
  };
}

/**
 * Spreads to `{ [key]: value }` when there is a value, and to `{}` when there is
 * not.
 *
 * Written out because `{ tautulli: maybe }` is *not* the same as omitting the key:
 * a present-but-undefined member satisfies `'tautulli' in sdk`, so an extension
 * feature-detecting the capability would find it and then call a method on
 * `undefined`. The distinction is load-bearing for exactly one capability today,
 * and it is a mistake worth making impossible rather than remembering.
 */
function optionalMember<TKey extends string, TValue>(
  key: TKey,
  value: TValue | undefined
): { [K in TKey]?: TValue } {
  return (value === undefined ? {} : { [key]: value }) as {
    [K in TKey]?: TValue;
  };
}

/** The most history `sdk.tautulli.userHistory` will return, whatever it is asked. */
const TAUTULLI_HISTORY_CAP = 100;

/**
 * `sdk.tautulli`: read-only watch history through core's Tautulli client.
 *
 * `undefined` when the operator has not configured Tautulli — see the note on
 * {@link ExtensionTautulli} for why that is a normal state rather than an error,
 * and why the operator's API key stays on this side of the boundary.
 *
 * A fresh `TautulliAPI` per call rather than one per extension, deliberately: the
 * client captures the hostname and key in its axios instance at construction, so
 * a long-lived one would keep talking to the server the operator has since moved
 * away from. Construction is a couple of object allocations; the alternative is a
 * cache that has to be invalidated from the settings form.
 */
function buildTautulli(
  extensionId: string,
  options: ActivateExtensionsOptions
): ExtensionTautulli | undefined {
  const readTautulli =
    options.getTautulliSettings ?? (() => getSettings().tautulli);

  // `hostname` rather than "any field set": it is the one field without which the
  // client's `baseURL` is nonsense, so it is what "configured" means here.
  if (!readTautulli().hostname) {
    return undefined;
  }

  /** One `try` for all three members, so the failure contract is written once. */
  const attempt = async <T>(
    what: string,
    fallback: T,
    fetch: (tautulli: TautulliAPI) => Promise<T>
  ): Promise<T> => {
    try {
      return await fetch(new TautulliAPI(readTautulli()));
    } catch (e) {
      logger.warn('Extension could not reach Tautulli', {
        label: 'Extensions',
        extensionId,
        lookup: what,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      return fallback;
    }
  };

  return {
    reachable: () =>
      attempt('info', false, async (tautulli) => {
        await tautulli.getInfo();
        return true;
      }),
    userTotals: (plexUserId) =>
      attempt<ExtensionWatchTotals | null>(
        'userTotals',
        null,
        async (tautulli) => {
          // Core's method takes a `User` and reads `plexId` off it. Passing a
          // partial rather than loading the real row: the extension already has a
          // user (that is where the id came from), and a second query here would be
          // a read core does not need to answer this.
          const stats = await tautulli.getUserWatchStats({
            plexId: plexUserId,
          } as User);

          return {
            plays: stats.total_plays,
            // Tautulli reports seconds; the SDK's unit is milliseconds. See
            // {@link ExtensionWatchTotals}.
            watchTimeMs: stats.total_time * 1000,
          };
        }
      ),
    userHistory: (plexUserId, { limit = TAUTULLI_HISTORY_CAP } = {}) =>
      attempt<ExtensionWatchRecord[]>('userHistory', [], async (tautulli) => {
        const records = await tautulli.getUserWatchHistory({
          plexId: plexUserId,
        } as User);

        return (
          records
            // A record with no rating key cannot be attributed to a title, and
            // passing it through would have the caller key an aggregate on
            // `'undefined'`.
            .filter((record) => record.rating_key != null)
            .slice(0, Math.min(limit, TAUTULLI_HISTORY_CAP))
            .map((record) => ({
              ratingKey: String(record.rating_key),
              ...optionalMember(
                'seriesRatingKey',
                record.grandparent_rating_key != null
                  ? String(record.grandparent_rating_key)
                  : undefined
              ),
              mediaType: record.media_type,
              title: record.title,
              durationMs: record.duration * 1000,
              // Tautulli's `date` is epoch *seconds*.
              watchedAt: new Date(record.date * 1000),
              plexUserId: record.user_id,
            }))
        );
      }),
  };
}

/**
 * `sdk.media.remove`. Core owns the removal; this only asks for it.
 *
 * The whole operation, including the save, because an extension has no
 * repository for core's `Media` — `removeMediaFromServarr` deliberately leaves
 * persistence to its caller, and for an extension this *is* the caller.
 */
function buildMediaRemove(extensionId: string): ExtensionMediaWrite['remove'] {
  return async (mediaId, is4k = false) => {
    const repository = getRepository(Media);
    const media = await repository.findOne({ where: { id: mediaId } });

    if (!media) {
      // Thrown rather than silently ignored: an extension asking to remove a row
      // that is not there has stale state, and swallowing that would make it
      // look like the removal succeeded.
      throw new Error(`Media ${mediaId} does not exist`);
    }

    // `NoServarrServerError` and any arr failure propagate from here, before the
    // save, so a failed removal never leaves a row marked DELETED.
    await removeMediaFromServarr(media, is4k);
    await repository.save(media);

    logger.info('Extension removed media', {
      label: 'Extensions',
      extensionId,
      mediaId,
      is4k,
    });
  };
}

function buildRequests(): ExtensionRequests {
  return {
    list: ({ userId, mediaId, take, skip } = {}) =>
      getRepository(MediaRequest).find({
        where: {
          ...(userId !== undefined ? { requestedBy: { id: userId } } : {}),
          ...(mediaId !== undefined ? { media: { id: mediaId } } : {}),
        },
        relations: { media: true, requestedBy: true, seasons: true },
        order: { id: 'ASC' },
        take,
        skip,
      }),
    get: (id) =>
      getRepository(MediaRequest).findOne({
        where: { id },
        relations: { media: true, requestedBy: true, seasons: true },
      }),
  };
}

/**
 * `sdk.settings`: core's main settings when `requires.settings` asked for them,
 * and the extension's own declared values when its manifest provides any.
 *
 * Getters rather than snapshots so an extension sees a value the operator changes
 * after boot — for its own settings that is the whole point, since the admin form
 * writes them into a running Seerr — and frozen so it cannot pretend to write one
 * back. `own` is unredacted: see the note on {@link ExtensionSettings}.
 */
function buildSettings(
  extensionId: string,
  wantsMain: boolean,
  options: ActivateExtensionsOptions
): ExtensionSettings {
  const readMain = options.getMainSettings ?? (() => getSettings().main);
  const readOwn = options.getSettingValues ?? getExtensionSettingValues;
  const readTautulli =
    options.getTautulliSettings ?? (() => getSettings().tautulli);

  // `own` is unconditional once `settings` is attached at all: an extension that
  // declares no settings gets `{}`, which reads the same as one whose operator has
  // configured nothing. `main` is withheld unless required, because asking for
  // core's settings is a separate declaration with its own reason to be reviewed.
  const settings: ExtensionSettings = {
    get own(): Readonly<Record<string, ExtensionSettingValue>> {
      // Frozen over a *copy*. `Object.freeze` mutates its argument, so freezing
      // what `readOwn` returned would reach back and seal the caller's own object
      // — harmless for the default reader, which builds a fresh one per call, but
      // it would permanently freeze any store the resolver hands out by reference.
      return Object.freeze({ ...readOwn(extensionId) });
    },
  };

  if (wantsMain) {
    // Tautulli travels with `main`, not with `own`: it is *core's* configuration,
    // so it is gated by the same `requires.settings` declaration and reviewed the
    // same way.
    Object.defineProperty(settings, 'tautulli', {
      enumerable: true,
      get: (): Readonly<Omit<TautulliSettings, 'apiKey'>> | undefined => {
        // Destructured out rather than blanked, so `'apiKey' in tautulli` is
        // false — an extension can feature-detect the absence instead of
        // discovering it by calling Tautulli with an empty key.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { apiKey, ...connection } = readTautulli();

        // `undefined` rather than `{}` for an unconfigured Tautulli: core's
        // default is an empty object, and every field being optional means an
        // extension could not otherwise tell "not configured" from "configured
        // with nothing".
        return Object.values(connection).some((value) => value !== undefined)
          ? Object.freeze(connection)
          : undefined;
      },
    });

    // `defineProperty` rather than a conditional spread, which would *call* the
    // getter and copy its result — turning the live read into a snapshot taken at
    // activation, which is exactly what this function exists not to do.
    Object.defineProperty(settings, 'main', {
      enumerable: true,
      get: (): Readonly<MainSettings> =>
        Object.freeze({ ...readMain(), apiKey: '' }),
    });
  }

  return settings;
}

function buildNotify(
  extensionId: string,
  keys: string[],
  options: ActivateExtensionsOptions
): ExtensionNotify {
  const declared = new Set(keys);

  return {
    send: async (key, payload) => {
      if (!declared.has(key)) {
        throw new Error(
          `Extension "${extensionId}" sent notification "${key}", which its manifest does not declare`
        );
      }

      if (options.sendNotification) {
        await options.sendNotification(extensionId, key, payload);
        return;
      }

      // No sender injected, which outside a test means the host was built
      // without one. Logged rather than thrown: an extension must not fail
      // because the host cannot deliver.
      logger.warn('Extension notification delivery is not wired up', {
        label: 'Extensions',
        extensionId,
        notificationType: `${extensionId}:${key}`,
        subject: payload.subject,
      });
    },
  };
}

function toArray<T>(value: MixedList<T> | undefined): T[] {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : Object.values(value);
}
