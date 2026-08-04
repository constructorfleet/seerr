import { getRepository } from '@server/datasource';
import { ExtensionPermission } from '@server/entity/ExtensionPermission';
import { User } from '@server/entity/User';
import {
  EXTENSION_ID_PATTERN,
  EXTENSION_KEY_PATTERN,
} from '@server/lib/extensions/manifest';
import type { ExtensionRegistry } from '@server/lib/extensions/registry';
import type { ExtensionPermissionKey } from '@server/lib/extensions/types';
import type { PermissionCheckOptions } from '@server/lib/permissions';
import { Permission, hasPermission } from '@server/lib/permissions';
import logger from '@server/logger';
import type { EntityManager } from 'typeorm';
import { In } from 'typeorm';

/**
 * Separates an extension id from one of its local permission keys. Neither
 * `EXTENSION_ID_PATTERN` nor `EXTENSION_KEY_PATTERN` admits a colon, so a
 * namespaced permission always splits back into exactly the two parts it was
 * built from.
 */
const NAMESPACE_SEPARATOR = ':';

/** Core `Permission` member names, without the enum's reverse mapping. */
const corePermissionsByName = new Map<string, Permission>(
  Object.entries(Permission).filter(
    (entry): entry is [string, Permission] =>
      isNaN(Number(entry[0])) && typeof entry[1] === 'number'
  )
);

/** A permission a caller may ask about: an extension key or a core member. */
export type ExtensionPermissionRequest = ExtensionPermissionKey | Permission;

/**
 * The core `Permission` member name for a value, for reporting `requiresCore`
 * back to the editor UI, which addresses core permissions by name.
 */
export function corePermissionName(permission: Permission): string | undefined {
  for (const [name, value] of corePermissionsByName) {
    if (value === permission) {
      return name;
    }
  }

  return undefined;
}

/**
 * One manifest permission, resolved: namespaced, with its `requiresCore` names
 * turned into `Permission` values and `default` defaulted.
 */
export interface ExtensionPermissionDeclaration {
  /** `<extensionId>:<key>`, as stored in `ext_permission.permission`. */
  permission: string;
  extensionId: string;
  /** The manifest-local key, not namespaced. */
  key: string;
  name: string;
  description?: string;
  /** Granted to newly created users. */
  default: boolean;
  /** Core permissions the holder must *also* hold for this one to apply. */
  requiresCore: Permission[];
}

export interface ExtensionPermissionCheckOptions extends Partial<PermissionCheckOptions> {
  /**
   * The extension a bare key belongs to, so an extension can ask about its own
   * `view_own` without namespacing it first. Ignored for keys that are already
   * namespaced or that name a core `Permission`.
   */
  extensionId?: string;
}

/**
 * Where the declared permissions come from.
 *
 * Injected rather than read from a module-global registry so this module has no
 * boot-order dependency: slice 5 points it at the real registry, and tests point
 * it at a literal list. Defaults to none, which makes every extension permission
 * an inert string — the correct behaviour with nothing installed.
 */
type DeclarationProvider = () => ExtensionPermissionDeclaration[];

let provideDeclarations: DeclarationProvider = () => [];

// #region namespacing

/**
 * `('watch-history', 'view_own')` → `'watch-history:view_own'`.
 *
 * @throws when either part is invalid. The result is written to the database and
 * compared against manifest declarations, so an unvalidated part would produce a
 * permission that can be granted but never matched.
 */
export function buildExtensionPermission(
  extensionId: string,
  key: string
): string {
  if (!EXTENSION_ID_PATTERN.test(extensionId)) {
    throw new Error(`"${extensionId}" is not a valid extension id`);
  }

  if (!EXTENSION_KEY_PATTERN.test(key)) {
    throw new Error(`"${key}" is not a valid extension permission key`);
  }

  return `${extensionId}${NAMESPACE_SEPARATOR}${key}`;
}

/**
 * The inverse of {@link buildExtensionPermission}, or `undefined` if `value` is
 * not a namespaced extension permission — which is how core `Permission` names
 * and stray strings are told apart from extension keys.
 */
export function parseExtensionPermission(
  value: string
): { extensionId: string; key: string } | undefined {
  const parts = value.split(NAMESPACE_SEPARATOR);

  if (parts.length !== 2) {
    return undefined;
  }

  const [extensionId, key] = parts;

  if (!EXTENSION_ID_PATTERN.test(extensionId)) {
    return undefined;
  }

  if (!EXTENSION_KEY_PATTERN.test(key)) {
    return undefined;
  }

  return { extensionId, key };
}

/** Whether `value` is shaped like `<extensionId>:<key>`. */
export function isExtensionPermission(value: string): boolean {
  return parseExtensionPermission(value) !== undefined;
}

// #endregion

// #region declarations

/**
 * Points the resolver at a set of declarations. Call at boot with the registry
 * (see {@link setExtensionPermissionRegistry}).
 */
export function setExtensionPermissionDeclarations(
  provider: DeclarationProvider
): void {
  provideDeclarations = provider;
}

/** Wires the resolver to a live registry, for `server/index.ts` (slice 5). */
export function setExtensionPermissionRegistry(
  registry: ExtensionRegistry
): void {
  setExtensionPermissionDeclarations(() => declarationsFromRegistry(registry));
}

/** Every permission the installed, non-quarantined extensions declare. */
export function getExtensionPermissionDeclarations(): ExtensionPermissionDeclaration[] {
  return provideDeclarations();
}

/**
 * Resolves the manifest permissions of every extension that is loaded and not
 * quarantined.
 *
 * A `failed` or `disabled` extension contributes nothing, so its permissions
 * stop being enforceable while its rows stay on disk: uninstalling and
 * reinstalling an extension restores the grants it had, which is the point of
 * string keys over recycled bits.
 */
export function declarationsFromRegistry(
  registry: ExtensionRegistry
): ExtensionPermissionDeclaration[] {
  return registry
    .all()
    .filter((entry) => entry.status === 'pending' || entry.status === 'active')
    .flatMap((entry) =>
      (entry.manifest?.provides?.permissions ?? []).map((declared) => ({
        permission: buildExtensionPermission(entry.id, declared.key),
        extensionId: entry.id,
        key: declared.key,
        ...(declared.description ? { description: declared.description } : {}),
        name: declared.name,
        default: declared.default ?? false,
        requiresCore: (declared.requiresCore ?? []).flatMap((name) => {
          const core = corePermissionsByName.get(name);

          return core === undefined ? [] : [core];
        }),
      }))
    );
}

/**
 * The declarations keyed by namespaced permission.
 *
 * Built once per query rather than looked up per permission: the registry-backed
 * provider re-derives its list on every call, so a per-permission lookup would
 * rebuild it once for each permission a caller asks about.
 */
function declarationMap(): Map<string, ExtensionPermissionDeclaration> {
  return new Map(
    provideDeclarations().map((declaration) => [
      declaration.permission,
      declaration,
    ])
  );
}

// #endregion

// #region queries

/**
 * The namespaced permissions a user has been granted, as stored — without the
 * ADMIN short-circuit and without `requiresCore` applied.
 *
 * This is the editable state a permission editor binds to: it must show the box
 * an operator ticked even when a missing core permission currently makes it
 * inert. {@link getEffectiveExtensionPermissions} is the resolved view.
 */
export async function getExtensionPermissions(
  userId: number
): Promise<string[]> {
  const rows = await getRepository(ExtensionPermission).find({
    where: { userId },
    select: { permission: true },
  });

  return rows.map((row) => row.permission).sort((a, b) => a.localeCompare(b));
}

/**
 * The extension permissions that currently *apply* to a user: every declared
 * permission for an admin, otherwise the granted ones whose `requiresCore` is
 * satisfied.
 *
 * One query for the user and at most one for their rows, so the client gets the
 * whole resolved set without a request per permission.
 */
export async function getEffectiveExtensionPermissions(
  userId: number
): Promise<string[]> {
  const user = await findUser(userId);

  if (!user) {
    return [];
  }

  if (hasPermission(Permission.ADMIN, user.permissions)) {
    return provideDeclarations()
      .map((declaration) => declaration.permission)
      .sort((a, b) => a.localeCompare(b));
  }

  const granted = await getExtensionPermissions(userId);
  const byPermission = declarationMap();

  return granted.filter((permission) =>
    coreRequirementMet(byPermission.get(permission), user.permissions)
  );
}

/**
 * Whether a user holds `permission`, which may be a namespaced extension key, a
 * bare key plus `options.extensionId`, a core `Permission`, a core member name,
 * or an array mixing all of those.
 *
 * Two queries at most regardless of how many permissions are asked about: the
 * user once, and their granted rows once, lazily and only if an extension key is
 * actually involved.
 */
export async function hasExtensionPermission(
  userId: number,
  permission: ExtensionPermissionRequest | ExtensionPermissionRequest[],
  options: ExtensionPermissionCheckOptions = { type: 'and' }
): Promise<boolean> {
  const requested = Array.isArray(permission) ? permission : [permission];

  // Matches core `hasPermission`, which returns true when asked for nothing.
  if (!requested.length) {
    return true;
  }

  const user = await findUser(userId);

  if (!user) {
    return false;
  }

  // The same short-circuit as core `hasPermission`, so an admin is never locked
  // out of an extension — including one whose permissions are not declared
  // because it failed to load.
  if (hasPermission(Permission.ADMIN, user.permissions)) {
    return true;
  }

  let granted: Set<string> | undefined;
  let byPermission: Map<string, ExtensionPermissionDeclaration> | undefined;
  const results: boolean[] = [];

  for (const item of requested) {
    const core = toCorePermission(item);

    if (core !== undefined) {
      results.push(hasPermission(core, user.permissions));
      continue;
    }

    const namespaced = toNamespaced(item as string, options.extensionId);

    if (!namespaced) {
      logger.debug('Ignoring an unrecognized extension permission', {
        label: 'Extensions',
        permission: item,
        ...(options.extensionId ? { extensionId: options.extensionId } : {}),
      });
      results.push(false);
      continue;
    }

    granted ??= new Set(await getExtensionPermissions(userId));
    byPermission ??= declarationMap();

    results.push(
      granted.has(namespaced) &&
        coreRequirementMet(byPermission.get(namespaced), user.permissions)
    );
  }

  return options.type === 'or' ? results.some(Boolean) : results.every(Boolean);
}

/**
 * Backs `sdk.users.hasPermission`: the same resolution, with the calling
 * extension's id supplied so its own manifest keys need no namespacing.
 */
export function extensionHasPermission(
  extensionId: string,
  userId: number,
  permission: ExtensionPermissionRequest
): Promise<boolean> {
  return hasExtensionPermission(userId, permission, {
    type: 'and',
    extensionId,
  });
}

/**
 * `requiresCore` is enforced **at check time, not at grant time**.
 *
 * Core permissions change after a grant — an operator revokes `MANAGE_USERS`
 * from a user who already holds `watch-history:view_all` — and a grant-time-only
 * check would leave that stale grant live. The row is therefore stored
 * unconditionally and filtered on every read, so revoking the core permission
 * takes effect immediately and re-granting it restores the extension permission
 * without re-ticking anything.
 *
 * A permission no loaded extension declares has no requirement to enforce: its
 * rows are inert data, and inventing a requirement for them would silently
 * change what a reinstall restores.
 */
function coreRequirementMet(
  declaration: ExtensionPermissionDeclaration | undefined,
  permissions: number
): boolean {
  if (!declaration?.requiresCore.length) {
    return true;
  }

  return hasPermission(declaration.requiresCore, permissions, { type: 'and' });
}

function findUser(userId: number): Promise<User | null> {
  return getRepository(User).findOne({
    where: { id: userId },
    select: { id: true, permissions: true },
  });
}

/** The core `Permission` `item` names, or `undefined` if it names none. */
function toCorePermission(
  item: ExtensionPermissionRequest
): Permission | undefined {
  return typeof item === 'number'
    ? item
    : corePermissionsByName.get(item as string);
}

function toNamespaced(
  permission: string,
  extensionId: string | undefined
): string | undefined {
  if (isExtensionPermission(permission)) {
    return permission;
  }

  if (!extensionId || !EXTENSION_KEY_PATTERN.test(permission)) {
    return undefined;
  }

  return buildExtensionPermission(extensionId, permission);
}

// #endregion

// #region mutation

/**
 * Grants one or more namespaced extension permissions, idempotently.
 *
 * @throws when a permission is not namespaced. Rows are matched against manifest
 * declarations by exact string, so a bare `view_own` would be storable and never
 * matchable.
 */
export async function grantExtensionPermission(
  userId: number,
  permission: string | string[],
  manager?: EntityManager
): Promise<void> {
  const permissions = assertNamespaced(permission);

  if (!permissions.length) {
    return;
  }

  const repository = manager
    ? manager.getRepository(ExtensionPermission)
    : getRepository(ExtensionPermission);

  await repository.save(
    permissions.map(
      (granted) => new ExtensionPermission({ userId, permission: granted })
    )
  );
}

/** Revokes one or more permissions. Revoking one not held is a no-op. */
export async function revokeExtensionPermission(
  userId: number,
  permission: string | string[]
): Promise<void> {
  const permissions = Array.isArray(permission) ? permission : [permission];

  if (!permissions.length) {
    return;
  }

  await getRepository(ExtensionPermission).delete({
    userId,
    permission: In(permissions),
  });
}

/**
 * Replaces a user's granted permissions with exactly `permissions`.
 *
 * Only permissions a loaded extension declares may be set: a caller cannot write
 * a row for an extension that is not installed, which would otherwise become
 * live the moment one was.
 */
export async function setExtensionPermissions(
  userId: number,
  permissions: string[]
): Promise<void> {
  const declared = new Set(
    provideDeclarations().map((declaration) => declaration.permission)
  );
  const undeclared = permissions.filter(
    (permission) => !declared.has(permission)
  );

  if (undeclared.length) {
    throw new Error(
      `No installed extension declares ${undeclared
        .map((permission) => `"${permission}"`)
        .join(', ')}`
    );
  }

  const current = await getExtensionPermissions(userId);
  const wanted = new Set(permissions);

  await revokeExtensionPermission(
    userId,
    current.filter((permission) => !wanted.has(permission))
  );
  await grantExtensionPermission(
    userId,
    permissions.filter((permission) => !current.includes(permission))
  );
}

/**
 * Grants the `default: true` permissions to a newly created user, mirroring what
 * `settings.main.defaultPermissions` does for the core bitmask. Called from
 * `ExtensionPermissionSubscriber` so every path that creates a user — local,
 * Plex and Jellyfin sign-in, and the admin's create-user form — is covered
 * without touching core's defaults mechanism.
 */
export async function grantDefaultExtensionPermissions(
  userId: number,
  manager?: EntityManager
): Promise<void> {
  const defaults = provideDeclarations()
    .filter((declaration) => declaration.default)
    .map((declaration) => declaration.permission);

  if (!defaults.length) {
    return;
  }

  await grantExtensionPermission(userId, defaults, manager);
}

function assertNamespaced(permission: string | string[]): string[] {
  const permissions = Array.isArray(permission) ? permission : [permission];

  for (const value of permissions) {
    if (!isExtensionPermission(value)) {
      throw new Error(
        `"${value}" is not a namespaced extension permission (<extensionId>:<key>)`
      );
    }
  }

  return permissions;
}

// #endregion
