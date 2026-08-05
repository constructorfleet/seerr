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
  ExtensionEvent,
  ExtensionKvStore,
  ExtensionMedia,
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
  ExtensionUsers,
} from '@server/lib/extensions/types';
import { removeMediaFromServarr } from '@server/lib/mediaRemoval';
import type { Permission } from '@server/lib/permissions';
import type { MainSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import fs from 'fs/promises';
import path from 'path';
import semver from 'semver';
import type { DataSource, DataSourceOptions, MixedList } from 'typeorm';
import { InstanceChecker, getMetadataArgsStorage } from 'typeorm';

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
    ...(canWrite ? { remove: buildMediaRemove(extensionId) } : {}),
  };

  return media as ExtensionMediaWrite;
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

  // `own` is unconditional once `settings` is attached at all: an extension that
  // declares no settings gets `{}`, which reads the same as one whose operator has
  // configured nothing. `main` is withheld unless required, because asking for
  // core's settings is a separate declaration with its own reason to be reviewed.
  const settings: ExtensionSettings = {
    get own(): Readonly<Record<string, ExtensionSettingValue>> {
      return Object.freeze(readOwn(extensionId));
    },
  };

  if (wantsMain) {
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
