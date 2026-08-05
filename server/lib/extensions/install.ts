import dataSource, { getRepository } from '@server/datasource';
import { ExtensionKv } from '@server/entity/ExtensionKv';
import { ExtensionNotificationSubscription } from '@server/entity/ExtensionNotificationSubscription';
import { ExtensionPermission } from '@server/entity/ExtensionPermission';
import {
  HOST_API_VERSION,
  MANIFEST_FILENAME,
  extensionsDirectory,
} from '@server/lib/extensions/loader';
import type { ExtensionManifest } from '@server/lib/extensions/manifest';
import {
  EXTENSION_ID_PATTERN,
  parseManifest,
} from '@server/lib/extensions/manifest';
import { extensionTablePrefix } from '@server/lib/extensions/migrations';
import logger from '@server/logger';
import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import semver from 'semver';
import { promisify } from 'util';

export { MANIFEST_FILENAME };

const execFileAsync = promisify(execFile);

/**
 * A fetch is given at most this long. An extension install is an interactive
 * admin action, so a registry that has stopped answering must fail rather than
 * hold the request open indefinitely.
 */
const FETCH_TIMEOUT = 300_000;

/**
 * Prefix for the staging directory, created *inside* the extensions directory so
 * the final move is a rename on the same filesystem rather than a copy that can
 * half-succeed.
 *
 * The leading dot keeps it out of the way, but the real reason discovery cannot
 * trip over it is that the fetched package lands one level deeper, in
 * `<staging>/package/` — `discoverExtensions` looks for a manifest directly
 * inside each directory it finds and silently ignores one that has none.
 */
const STAGING_PREFIX = '.install-';

/** Thrown for every install and uninstall failure, with a legible message. */
export class ExtensionInstallError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ExtensionInstallError';
  }
}

/**
 * Populates `directory` with the root of an extension package — the directory
 * that contains `seerr-extension.json` — or returns the path of a package root it
 * created somewhere underneath.
 *
 * The indirection is what makes installs testable without a network: the two real
 * fetchers shell out to `npm` and `git`, and a test passes one that copies a
 * fixture.
 */
export type ExtensionFetcher = (
  directory: string
) => Promise<string | void> | string | void;

export interface InstallExtensionOptions {
  /** An npm spec (`name`, `name@2.1.0`, `@scope/name`) or a git URL. */
  source: string;
  /** Defaults to {@link extensionsDirectory}. Injectable for tests. */
  directory?: string;
  /**
   * The id the operator asked for, when that is knowable from the source. A
   * manifest claiming a different id is refused rather than installed under a
   * name nobody typed.
   */
  expectedId?: string;
  /** Defaults to {@link fetcherFor}. Injectable for tests. */
  fetch?: ExtensionFetcher;
}

export interface InstallExtensionResult {
  id: string;
  /** Where it landed: `<directory>/<id>`. */
  directory: string;
  manifest: ExtensionManifest;
  /** Whether an install of the same id was replaced. */
  replaced: boolean;
}

/**
 * Fetches an extension, validates it, and only then moves it into place.
 *
 * Everything is done in a staging directory, and every check that discovery
 * would later make — manifest present, manifest valid, id agrees with the
 * directory it will occupy, `apiVersion` satisfied by this host, entry point
 * actually there — is made *before* anything is moved. A rejected install
 * therefore leaves no directory behind, rather than installing something that
 * quarantines itself on the next boot.
 *
 * Nothing here sandboxes the extension: it is trusted code, and will be
 * `require()`d in-process once enabled (see the trust model in
 * docs/specs/extension-system.md). What this does is refuse to accept a package
 * that cannot work, and refuse to run its lifecycle scripts while deciding.
 *
 * @throws {ExtensionInstallError} for every failure mode, with the source named.
 */
export async function installExtension(
  options: InstallExtensionOptions
): Promise<InstallExtensionResult> {
  const { source, expectedId } = options;
  const directory = options.directory ?? extensionsDirectory();
  const fetch = options.fetch ?? fetcherFor(source);

  await fs.mkdir(directory, { recursive: true });

  const staging = await fs.mkdtemp(path.join(directory, STAGING_PREFIX));

  try {
    const root = await fetchInto(staging, source, fetch);
    const manifest = await validate(root, source, expectedId);
    const target = path.join(directory, manifest.id);
    const replaced = await pathExists(target);

    await swap(root, target, staging, source, replaced);

    logger.info(
      `Installed extension "${manifest.id}" ${manifest.version} from ${source}`,
      { label: 'Extensions' }
    );

    return { id: manifest.id, directory: target, manifest, replaced };
  } finally {
    // Unconditional: a failed install must not leave a directory that the next
    // install, or a concurrent discovery, has to reason about.
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function fetchInto(
  staging: string,
  source: string,
  fetch: ExtensionFetcher
): Promise<string> {
  const destination = path.join(staging, 'package');
  await fs.mkdir(destination);

  let root: string | void;

  try {
    root = await fetch(destination);
  } catch (e) {
    throw new ExtensionInstallError(
      `Could not fetch "${source}": ${messageOf(e)}`,
      e
    );
  }

  return root || destination;
}

/**
 * Every check discovery would make, made here instead, so that failing one means
 * "not installed" rather than "installed and broken".
 */
async function validate(
  root: string,
  source: string,
  expectedId: string | undefined
): Promise<ExtensionManifest> {
  const manifestPath = path.join(root, MANIFEST_FILENAME);
  let raw: string;

  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch (e) {
    throw new ExtensionInstallError(
      `"${source}" is not a Seerr extension: it has no ${MANIFEST_FILENAME}`,
      e
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ExtensionInstallError(
      `The ${MANIFEST_FILENAME} in "${source}" is not valid JSON: ${messageOf(e)}`,
      e
    );
  }

  let manifest: ExtensionManifest;

  try {
    manifest = parseManifest(parsed);
  } catch (e) {
    throw new ExtensionInstallError(
      `"${source}" has an invalid manifest. ${messageOf(e)}`,
      e
    );
  }

  if (expectedId !== undefined && manifest.id !== expectedId) {
    // The id names the directory, which in turn namespaces this extension's
    // tables, routes and permissions. Installing "a" and getting "b" would put
    // code the operator did not ask for into a namespace they did not choose.
    throw new ExtensionInstallError(
      `"${source}" declares the extension id "${manifest.id}", but "${expectedId}" was requested; ` +
        `an extension must be installed under the id in its manifest`
    );
  }

  if (!semver.satisfies(HOST_API_VERSION, manifest.apiVersion)) {
    throw new ExtensionInstallError(
      `"${source}" requires host API "${manifest.apiVersion}", but this Seerr provides ${HOST_API_VERSION}`
    );
  }

  if (!(await pathExists(path.join(root, manifest.server)))) {
    // Cheap here, and the alternative is an install that looks fine until the
    // next boot quarantines it for an unreadable entry point.
    throw new ExtensionInstallError(
      `"${source}" declares its entry point as "${manifest.server}", which is not in the package`
    );
  }

  return manifest;
}

/**
 * Moves the validated package into place, keeping any existing install
 * recoverable until the new one is actually there.
 */
async function swap(
  root: string,
  target: string,
  staging: string,
  source: string,
  replaced: boolean
): Promise<void> {
  const backup = path.join(staging, 'previous');

  if (replaced) {
    // Moved aside rather than deleted, so a failed rename leaves the operator
    // with the version they had instead of nothing at all. Also removes stale
    // files: an upgrade that drops a file must not leave the old one loadable.
    await fs.rename(target, backup);
  }

  try {
    await fs.rename(root, target);
  } catch (e) {
    if (replaced) {
      await fs.rename(backup, target).catch(() => {
        logger.error('Could not restore the previous extension install', {
          label: 'Extensions',
          directory: target,
        });
      });
    }

    throw new ExtensionInstallError(
      `Could not install "${source}" into ${target}: ${messageOf(e)}`,
      e
    );
  }
}

export interface UninstallExtensionOptions {
  id: string;
  /** Defaults to {@link extensionsDirectory}. Injectable for tests. */
  directory?: string;
  /**
   * Also delete the extension's `ext_permission` and
   * `ext_notification_subscription` rows. Off by default — see
   * {@link uninstallExtension}.
   */
  purgeData?: boolean;
}

export interface UninstallExtensionResult {
  /** Whether a directory was actually there to remove. */
  removed: boolean;
  /** `ext_<id>_*` tables dropped, in the order dropped. */
  droppedTables: string[];
  purgedPermissions: number;
  purgedSubscriptions: number;
}

/**
 * Removes an extension's directory and the state that is meaningless without it.
 *
 * **What is dropped, always:** the `ext_<id>_*` tables the extension's own
 * migrations created, including its `ext_<id>_migration` tracking table, and its
 * rows in the shared `ext_kv`. These are the extension's private storage. Their
 * schema was defined by entity classes that leave with the directory, so keeping
 * them would leave tables nothing can read, and a reinstall of a later major
 * version would meet a table of the wrong shape with a migration history saying
 * it had already been brought up to date.
 *
 * **What is kept, unless `purgeData`:** `ext_permission` and
 * `ext_notification_subscription` rows. These are not the extension's data, they
 * are the *operator's* decisions about it — which users may use it, and who wants
 * to hear from it. They are string-keyed (`<id>:<key>`) precisely so they stay
 * meaningful across an uninstall: slice 4 made a quarantined extension's
 * permissions unenforceable while leaving the rows on disk, so that fixing and
 * reloading it restores the grants rather than silently dropping them. Uninstall
 * keeps that property, because "uninstall, upgrade, reinstall" is the ordinary
 * way to move between versions and a per-user grant set an operator curated is
 * not something they can reconstruct. An orphaned row is inert: nothing enforces
 * a permission no installed extension declares, and nothing sends a notification
 * no installed extension raises.
 *
 * `purgeData` is the explicit way to say "and forget it entirely".
 *
 * @throws {ExtensionInstallError} if `id` is not a valid extension id.
 */
export async function uninstallExtension(
  options: UninstallExtensionOptions
): Promise<UninstallExtensionResult> {
  const { id, purgeData = false } = options;

  if (!EXTENSION_ID_PATTERN.test(id)) {
    // `id` is joined onto the extensions directory and interpolated into table
    // names, so this check is what stands between a request parameter and an
    // arbitrary recursive delete.
    throw new ExtensionInstallError(
      `"${id}" is not a valid extension id, so there is nothing to uninstall`
    );
  }

  const directory = options.directory ?? extensionsDirectory();
  const target = path.join(directory, id);
  const removed = await pathExists(target);

  const droppedTables = await dropExtensionTables(id);
  await getRepository(ExtensionKv).delete({ extensionId: id });

  const purgedPermissions = purgeData ? await purgePermissions(id) : 0;
  const purgedSubscriptions = purgeData ? await purgeSubscriptions(id) : 0;

  // Last, because it is the one step with nothing to undo it: if the database
  // work fails, the extension is still installed and the operator can retry.
  await fs.rm(target, { recursive: true, force: true });

  logger.info(
    removed
      ? `Uninstalled extension "${id}"`
      : `Extension "${id}" was not installed; cleaned up its data anyway`,
    { label: 'Extensions', droppedTables, purgeData }
  );

  return { removed, droppedTables, purgedPermissions, purgedSubscriptions };
}

/**
 * Drops every table in the extension's `ext_<id>_` namespace.
 *
 * Matched by prefix rather than from entity metadata, because the extension's
 * entities are gone by the time an operator uninstalls a broken version, and a
 * table left behind by a migration that ran before its entity was removed would
 * otherwise be invisible.
 */
async function dropExtensionTables(id: string): Promise<string[]> {
  if (!dataSource.isInitialized) {
    logger.warn('Skipping extension table cleanup: no database connection', {
      label: 'Extensions',
      extensionId: id,
    });
    return [];
  }

  const prefix = extensionTablePrefix(id);
  const queryRunner = dataSource.createQueryRunner();
  const dropped: string[] = [];

  try {
    const tables = await queryRunner.getTables();

    for (const table of tables) {
      // Postgres reports `schema.table`; the namespace prefix is on the table.
      const name = table.name.split('.').pop() ?? table.name;

      if (!name.startsWith(prefix)) {
        continue;
      }

      try {
        await queryRunner.dropTable(table, true);
        dropped.push(name);
      } catch (e) {
        // One undroppable table must not abort the uninstall: the directory
        // still has to go, or the extension stays half-installed forever.
        logger.error('Could not drop an extension table', {
          label: 'Extensions',
          extensionId: id,
          table: name,
          errorMessage: messageOf(e),
        });
      }
    }
  } finally {
    await queryRunner.release();
  }

  return dropped;
}

async function purgePermissions(id: string): Promise<number> {
  const repository = getRepository(ExtensionPermission);
  const where = 'permission LIKE :prefix';
  const parameters = { prefix: `${id}:%` };

  // Counted before deleting rather than trusting `affected`, which drivers report
  // inconsistently. `EXTENSION_ID_PATTERN` allows neither `%` nor `_`, so the id
  // cannot smuggle a LIKE wildcard into the pattern.
  const count = await repository
    .createQueryBuilder('permission')
    .where(where, parameters)
    .getCount();

  await repository
    .createQueryBuilder()
    .delete()
    .where(where, parameters)
    .execute();

  return count;
}

async function purgeSubscriptions(id: string): Promise<number> {
  const repository = getRepository(ExtensionNotificationSubscription);
  const where = 'notificationType LIKE :prefix';
  const parameters = { prefix: `${id}:%` };

  const count = await repository
    .createQueryBuilder('subscription')
    .where(where, parameters)
    .getCount();

  await repository
    .createQueryBuilder()
    .delete()
    .where(where, parameters)
    .execute();

  return count;
}

/** A command to run, as {@link execFileAsync} takes it. */
export interface FetchCommand {
  command: string;
  args: string[];
  cwd: string;
}

/**
 * Anything that looks like a git remote. Everything else is treated as an npm
 * spec, which is the more common case and the one with the friendlier failure.
 *
 * Note that a scoped package (`@seerr/history`) must not match the scp-style
 * remote alternative: the `@` is leading there, and a remote has a host after the
 * `:` rather than a path, so the alternative requires a non-`@` first character.
 */
const GIT_SOURCE =
  /^(https?|ssh|git):\/\/|^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:|\.git(#.*)?$/;

/** Whether a source will be fetched with npm or with git. */
export function sourceKind(source: string): 'npm' | 'git' {
  return GIT_SOURCE.test(source) ? 'git' : 'npm';
}

/** Picks a fetcher from the shape of the source an operator typed. */
export function fetcherFor(source: string): ExtensionFetcher {
  return sourceKind(source) === 'git' ? gitFetcher(source) : npmFetcher(source);
}

/**
 * The npm command an install runs.
 *
 * `--prefix` is not optional: without it npm walks *up* from its working
 * directory looking for a `package.json`, and the extensions directory lives
 * under a config directory that may well be inside a Seerr checkout. An install
 * must never be able to touch Seerr's own dependency tree.
 */
export function npmFetchCommand(spec: string, directory: string): FetchCommand {
  if (spec.startsWith('-')) {
    // `args` never goes through a shell, so there is no injection here — but npm
    // would read this as an option rather than a package.
    throw new ExtensionInstallError(
      `"${spec}" is not a valid npm package specifier`
    );
  }

  return {
    command: 'npm',
    args: [
      'install',
      spec,
      '--prefix',
      directory,
      '--omit=dev',
      // Lifecycle scripts run before the manifest has been read, which is before
      // this install has decided whether to accept the package at all. An
      // extension is trusted once an operator installs it; a candidate being
      // validated is not yet.
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
    ],
    cwd: directory,
  };
}

/**
 * The npm command that installs a cloned extension's production dependencies.
 * A git source is a source tree, so unlike an npm tarball it arrives without
 * `node_modules`.
 */
export function npmDependenciesCommand(directory: string): FetchCommand {
  return {
    command: 'npm',
    args: [
      'install',
      '--prefix',
      directory,
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
    ],
    cwd: directory,
  };
}

/** Schemes a git remote legitimately uses. */
const GIT_URL = /^(https?|ssh|git):\/\/[^/]+\/.+$/;
const GIT_SCP_URL = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:.+$/;

/**
 * The git command an install runs. A `#ref` suffix on the URL selects a branch or
 * tag.
 *
 * Restricted to the network schemes on purpose: git's transport list includes
 * `file://` and `ext::`, which would turn "install from a git repo" into "read
 * any path the Seerr process can" or "run a command".
 */
export function gitFetchCommand(url: string, directory: string): FetchCommand {
  const hash = url.indexOf('#');
  const remote = hash === -1 ? url : url.slice(0, hash);
  const ref = hash === -1 ? undefined : url.slice(hash + 1);

  if (!GIT_URL.test(remote) && !GIT_SCP_URL.test(remote)) {
    throw new ExtensionInstallError(
      `"${url}" is not an http(s), ssh or git repository URL`
    );
  }

  if (ref !== undefined && !/^[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new ExtensionInstallError(
      `"${ref}" is not a valid branch or tag name`
    );
  }

  return {
    command: 'git',
    args: [
      'clone',
      '--depth',
      '1',
      '--single-branch',
      ...(ref ? ['--branch', ref] : []),
      remote,
      directory,
    ],
    cwd: directory,
  };
}

/**
 * Installs an npm package into the staging directory.
 *
 * npm produces a flat `node_modules`, so the requested package's dependencies
 * arrive as its *siblings*. They are moved underneath it, because only the
 * package itself is kept and Node resolves from the extension's own directory
 * outward once it is installed.
 */
export function npmFetcher(spec: string): ExtensionFetcher {
  return async (directory: string) => {
    const { command, args, cwd } = npmFetchCommand(spec, directory);

    // npm resolves the *nearest* package.json for its own bookkeeping; giving it
    // one here means it never considers looking further up.
    await fs.writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: 'seerr-extension-install', private: true })
    );

    await run(command, args, cwd);

    const modules = path.join(directory, 'node_modules');
    const name = await installedPackageName(directory, modules, spec);
    const root = path.join(modules, name);

    await nestDependencies(modules, name, root);

    return root;
  };
}

/**
 * Clones a git repository into the staging directory.
 *
 * `.git` is removed: what is installed is a snapshot, and for a shallow clone the
 * repository metadata is most of the download. Nothing is built — a git-installed
 * extension must commit whatever its manifest's `server` and panel `entry` paths
 * point at, because install runs no build and no lifecycle scripts.
 */
export function gitFetcher(url: string): ExtensionFetcher {
  return async (directory: string) => {
    const { command, args, cwd } = gitFetchCommand(url, directory);

    // `git clone` wants to create the directory itself, and refuses a non-empty
    // one. The staging directory is empty, which is exactly what it accepts.
    await run(command, args, path.dirname(cwd));
    await fs.rm(path.join(directory, '.git'), {
      recursive: true,
      force: true,
    });

    if (await hasDependencies(directory)) {
      const dependencies = npmDependenciesCommand(directory);
      await run(dependencies.command, dependencies.args, dependencies.cwd);
    }
  };
}

async function run(
  command: string,
  args: string[],
  cwd: string
): Promise<void> {
  try {
    await execFileAsync(command, args, { cwd, timeout: FETCH_TIMEOUT });
  } catch (e) {
    const { stderr } = e as { stderr?: string };
    const detail = stderr?.trim() || messageOf(e);

    throw new ExtensionInstallError(`${command} failed: ${detail}`, e);
  }
}

/**
 * The name npm actually installed. An operator may type `name@2.1.0`, a dist-tag,
 * or a tarball URL, so the spec is not the name; npm records the name in the
 * `package.json` it wrote.
 */
async function installedPackageName(
  directory: string,
  modules: string,
  spec: string
): Promise<string> {
  try {
    const written = JSON.parse(
      await fs.readFile(path.join(directory, 'package.json'), 'utf8')
    );
    const [name] = Object.keys(written.dependencies ?? {});

    if (name && (await pathExists(path.join(modules, name)))) {
      return name;
    }
  } catch {
    // Fall through to reading the tree, which is the ground truth anyway.
  }

  const entries = await readPackageDirectories(modules);

  if (entries.length !== 1) {
    throw new ExtensionInstallError(
      `Could not tell which package "${spec}" installed (found ${entries.length})`
    );
  }

  return entries[0];
}

/** Installed package names under a `node_modules`, scoped names included. */
async function readPackageDirectories(modules: string): Promise<string[]> {
  const names: string[] = [];

  for (const entry of await fs.readdir(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin') {
      continue;
    }

    if (entry.name.startsWith('@')) {
      for (const scoped of await fs.readdir(path.join(modules, entry.name))) {
        names.push(`${entry.name}/${scoped}`);
      }
      continue;
    }

    names.push(entry.name);
  }

  return names;
}

/** Moves the extension's flat-installed siblings under its own `node_modules`. */
async function nestDependencies(
  modules: string,
  name: string,
  root: string
): Promise<void> {
  const siblings = (await readPackageDirectories(modules)).filter(
    (sibling) => sibling !== name
  );

  if (!siblings.length) {
    return;
  }

  const nested = path.join(root, 'node_modules');

  for (const sibling of siblings) {
    const destination = path.join(nested, sibling);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(path.join(modules, sibling), destination);
  }
}

async function hasDependencies(directory: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(
      await fs.readFile(path.join(directory, 'package.json'), 'utf8')
    );

    return Object.keys(pkg.dependencies ?? {}).length > 0;
  } catch {
    // No package.json, or an unreadable one. An extension does not need one —
    // `seerr-extension.json` is what makes it an extension.
    return false;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
