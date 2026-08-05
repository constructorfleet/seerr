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
import { getSettings } from '@server/lib/settings';
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

/** Every permission `extensionId` declares, in manifest order. */
export function declarationsFor(
  extensionId: string
): ExtensionPermissionDeclaration[] {
  return provideDeclarations().filter(
    (declaration) => declaration.extensionId === extensionId
  );
}

/**
 * Resolves a namespaced permission against the declared set.
 *
 * The single place the "only a permission a loaded extension declares may be
 * written" rule lives, so the matrix writer and {@link setExtensionPermissions}
 * cannot drift apart on what counts as declared.
 *
 * @throws when nothing declares it, or when `extensionId` is given and something
 * *else* declares it — an admin editing one extension's matrix must not be able
 * to reach another extension's permissions through it.
 */
function assertDeclared(
  permission: string,
  extensionId?: string
): ExtensionPermissionDeclaration {
  const declaration = declarationMap().get(permission);

  if (
    !declaration ||
    (extensionId && declaration.extensionId !== extensionId)
  ) {
    throw new Error(
      extensionId
        ? `Extension "${extensionId}" does not declare "${permission}"`
        : `No installed extension declares "${permission}"`
    );
  }

  return declaration;
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

/** One user's standing on one permission, as the admin matrix renders it. */
export interface ExtensionPermissionHolder {
  id: number;
  displayName: string;
  email: string;
  avatar: string;
  /** Whether an `ext_permission` row backs this — the only revokable state. */
  granted: boolean;
  /** Whether it currently applies, by grant or by the ADMIN short-circuit. */
  effective: boolean;
  /**
   * True when `effective` comes from `hasPermission`'s ADMIN short-circuit rather
   * than a row. Reported separately so the UI does not offer a revoke for
   * something no row backs, and jointly with `granted: false` so it is obvious
   * that removing ADMIN would leave the user without the permission.
   */
  effectiveByAdmin: boolean;
  /** Core permissions this user lacks, which make a grant inert. */
  missingCore: string[];
}

/** One declared permission plus who holds it. */
export interface ExtensionPermissionMatrixEntry {
  permission: string;
  key: string;
  name: string;
  description?: string;
  /** `operator override ?? manifest default ?? false` — what new users get. */
  default: boolean;
  /** The manifest's flag, so the UI can show what it is overriding. */
  manifestDefault: boolean;
  /** The operator's override, or `undefined` when the manifest wins. */
  operatorDefault?: boolean;
  requiresCore: string[];
  holders: ExtensionPermissionHolder[];
}

export interface ExtensionPermissionMatrix {
  extensionId: string;
  permissions: ExtensionPermissionMatrixEntry[];
  /** Candidate users across the whole extension, for paging the UI. */
  total: number;
  take: number;
  skip: number;
}

/**
 * The default page size for the matrix's user list.
 *
 * Capped because an install can have thousands of users and the matrix renders a
 * row per user per permission. Kept in step with the other admin lists in
 * `server/routes/user`.
 */
const MATRIX_DEFAULT_TAKE = 50;

/**
 * The per-extension grant matrix: every permission `extensionId` declares, and
 * which users hold it.
 *
 * Only *candidate* users are loaded — those holding at least one of this
 * extension's permissions, plus every admin — rather than the whole user table
 * filtered in memory. Two queries regardless of how many permissions the
 * extension declares, and the page is applied by the database.
 *
 * Admins are candidates without a row because the ADMIN short-circuit means the
 * permission genuinely applies to them; omitting them would make the matrix
 * disagree with `hasExtensionPermission`. They are the reason the candidate set
 * is a union rather than just the grant holders.
 *
 * A disabled or uninstalled extension declares nothing, so `permissions` is
 * empty while its rows stay on disk — the same asymmetry as everywhere else in
 * this module.
 */
export async function getExtensionPermissionMatrix(
  extensionId: string,
  options: { take?: number; skip?: number } = {}
): Promise<ExtensionPermissionMatrix> {
  const take = Math.min(Math.max(options.take ?? MATRIX_DEFAULT_TAKE, 1), 100);
  const skip = Math.max(options.skip ?? 0, 0);
  const declared = declarationsFor(extensionId);
  const overrides = getSettings().extensions[extensionId]?.permissionDefaults;

  if (!declared.length) {
    return { extensionId, permissions: [], total: 0, take, skip };
  }

  const permissions = declared.map((declaration) => declaration.permission);

  // The candidate ids: anyone with a row for this extension, plus every admin.
  // A raw bitwise test because `permissions` is a bitmask, which no TypeORM
  // `where` operator can express.
  const candidates = getRepository(User)
    .createQueryBuilder('user')
    .select(['user.id'])
    .where(
      `(user.permissions & ${Permission.ADMIN}) != 0 OR user.id IN (
         SELECT grant_row."userId" FROM ext_permission grant_row
         WHERE grant_row.permission IN (:...permissions)
       )`,
      { permissions }
    );

  const total = await candidates.getCount();
  const users = await candidates
    .orderBy('user.id', 'ASC')
    .take(take)
    .skip(skip)
    .getMany();

  if (!users.length) {
    return {
      extensionId,
      permissions: declared.map((declaration) =>
        matrixEntry(declaration, [], overrides)
      ),
      total,
      take,
      skip,
    };
  }

  // Loaded through `find` rather than the builder above so `@AfterLoad` runs and
  // `displayName` is populated — the builder's `select` would starve it.
  const jointRows = await getRepository(ExtensionPermission).find({
    where: {
      userId: In(users.map((user) => user.id)),
      permission: In(permissions),
    },
  });
  const holders = await getRepository(User).find({
    where: { id: In(users.map((user) => user.id)) },
    order: { id: 'ASC' },
  });

  const grantedByUser = new Map<number, Set<string>>();
  for (const row of jointRows) {
    (
      grantedByUser.get(row.userId) ??
      grantedByUser.set(row.userId, new Set()).get(row.userId)!
    ).add(row.permission);
  }

  return {
    extensionId,
    permissions: declared.map((declaration) =>
      matrixEntry(
        declaration,
        holders.map((user) => {
          const isAdmin = hasPermission(Permission.ADMIN, user.permissions);
          const granted = !!grantedByUser
            .get(user.id)
            ?.has(declaration.permission);
          const missingCore = declaration.requiresCore
            .filter((core) => !hasPermission(core, user.permissions))
            .flatMap((core) => {
              const name = corePermissionName(core);

              return name ? [name] : [];
            });

          return {
            id: user.id,
            displayName: user.displayName,
            email: user.email,
            avatar: user.avatar,
            granted,
            effective: isAdmin || (granted && !missingCore.length),
            effectiveByAdmin: isAdmin,
            // An admin's requirements are short-circuited, so nothing about
            // them is "missing" in a way that affects the outcome.
            missingCore: isAdmin ? [] : missingCore,
          };
        }),
        overrides
      )
    ),
    total,
    take,
    skip,
  };
}

function matrixEntry(
  declaration: ExtensionPermissionDeclaration,
  holders: ExtensionPermissionHolder[],
  overrides: Record<string, boolean> | undefined
): ExtensionPermissionMatrixEntry {
  const operatorDefault = overrides?.[declaration.key];

  return {
    permission: declaration.permission,
    key: declaration.key,
    name: declaration.name,
    ...(declaration.description
      ? { description: declaration.description }
      : {}),
    default: operatorDefault ?? declaration.default,
    manifestDefault: declaration.default,
    ...(operatorDefault === undefined ? {} : { operatorDefault }),
    requiresCore: declaration.requiresCore.flatMap((core) => {
      const name = corePermissionName(core);

      return name ? [name] : [];
    }),
    holders,
  };
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
 * Grants or revokes one of `extensionId`'s permissions for a set of users in one
 * call — the admin grant matrix's writer.
 *
 * Deliberately *not* built on {@link setExtensionPermissions}, which replaces a
 * user's entire declared set: that would silently drop the user's grants for
 * every other extension, since the matrix only ever knows about this one. This
 * writes exactly the one permission named and touches nothing else, which also
 * leaves orphaned rows from an uninstalled extension intact.
 *
 * Unknown user ids are dropped rather than rejected, so a stale row in an admin
 * UI does not fail a bulk write that is otherwise entirely valid.
 *
 * @throws when `extensionId` does not declare `key`.
 */
export async function setExtensionPermissionHolders(
  extensionId: string,
  key: string,
  userIds: number[],
  granted: boolean
): Promise<void> {
  const { permission } = assertDeclared(
    buildExtensionPermission(extensionId, key),
    extensionId
  );

  if (!userIds.length) {
    return;
  }

  const existing = await getRepository(User).find({
    where: { id: In(userIds) },
    select: { id: true },
  });

  if (!existing.length) {
    return;
  }

  const ids = existing.map((user) => user.id);

  if (!granted) {
    await getRepository(ExtensionPermission).delete({
      userId: In(ids),
      permission,
    });

    return;
  }

  // `save` on the composite primary key, so re-granting what a user already
  // holds updates the same row instead of failing on a duplicate.
  await getRepository(ExtensionPermission).save(
    ids.map((userId) => new ExtensionPermission({ userId, permission }))
  );
}

/**
 * The effective default for one of an extension's permissions:
 * `operator override ?? manifest default ?? false`.
 *
 * Read from settings on every call rather than captured, so an override written
 * through the API applies to the very next user created without a restart.
 */
export function getExtensionPermissionDefault(
  extensionId: string,
  key: string
): boolean {
  const override =
    getSettings().extensions[extensionId]?.permissionDefaults?.[key];

  if (override !== undefined) {
    return override;
  }

  return (
    declarationsFor(extensionId).find((declaration) => declaration.key === key)
      ?.default ?? false
  );
}

/**
 * Records an operator override for a permission's `default` flag.
 *
 * Only affects users created *after* the write: nothing here touches
 * `ext_permission`. A default is a policy for new accounts, and retroactively
 * revoking would undo grants an operator made by hand through the matrix or the
 * per-user editor.
 *
 * Merged into the extension's existing entry so `enabled` survives. The whole
 * entry — overrides included — is dropped by `forgetExtensionSettings` on
 * uninstall, consistent with `enabled`: it is a decision about *this install's*
 * manifest keys, unlike the permission rows, which are decisions about users and
 * are deliberately kept.
 *
 * @throws when `extensionId` does not declare `key`, so an override cannot
 * accumulate for a permission that will never be granted.
 */
export async function setExtensionPermissionDefault(
  extensionId: string,
  key: string,
  value: boolean
): Promise<void> {
  assertDeclared(buildExtensionPermission(extensionId, key), extensionId);

  const settings = getSettings();
  const current = settings.extensions[extensionId];

  settings.extensions = {
    ...settings.extensions,
    [extensionId]: {
      ...current,
      // An extension with nothing recorded is enabled — the same default
      // `isExtensionEnabled` applies, so recording an override for an extension
      // this file has never mentioned must not switch it off.
      enabled: current?.enabled ?? true,
      permissionDefaults: {
        ...current?.permissionDefaults,
        [key]: value,
      },
    },
  };

  await settings.save();
}

/** Drops every override for an extension, restoring its manifest defaults. */
export async function clearExtensionPermissionDefaults(
  extensionId: string
): Promise<void> {
  const settings = getSettings();
  const current = settings.extensions[extensionId];

  if (!current?.permissionDefaults) {
    return;
  }

  const remaining = { ...current };
  delete remaining.permissionDefaults;

  settings.extensions = { ...settings.extensions, [extensionId]: remaining };

  await settings.save();
}

/**
 * Grants the default permissions to a newly created user, mirroring what
 * `settings.main.defaultPermissions` does for the core bitmask. Called from
 * `ExtensionPermissionSubscriber` so every path that creates a user — local,
 * Plex and Jellyfin sign-in, and the admin's create-user form — is covered
 * without touching core's defaults mechanism.
 *
 * Reads {@link getExtensionPermissionDefault}, so an operator override wins over
 * what the manifest declared.
 */
export async function grantDefaultExtensionPermissions(
  userId: number,
  manager?: EntityManager
): Promise<void> {
  const defaults = provideDeclarations()
    .filter((declaration) =>
      getExtensionPermissionDefault(declaration.extensionId, declaration.key)
    )
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
