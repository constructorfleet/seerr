import { ExtensionKv } from '@server/entity/ExtensionKv';
import { ExtensionNotificationSubscription } from '@server/entity/ExtensionNotificationSubscription';
import { ExtensionPermission } from '@server/entity/ExtensionPermission';
import { getMetadataArgsStorage } from 'typeorm';

/**
 * Core's own tables in the `ext_*` namespace: `ext_permission`, `ext_kv`, and
 * `ext_notification_subscription`.
 *
 * Read off the entity decorators rather than written out, so renaming a table in
 * its entity keeps {@link reservedExtensionId} honest instead of quietly
 * unreserving the old name and leaving the new one exposed.
 */
export function coreExtensionTableNames(): string[] {
  const targets = [
    ExtensionPermission,
    ExtensionKv,
    ExtensionNotificationSubscription,
  ];

  return getMetadataArgsStorage()
    .tables.filter((table) => targets.includes(table.target as never))
    .map((table) => table.name)
    .filter((name): name is string => !!name);
}

/**
 * The core table an extension id would collide with, or `undefined` if the id is
 * free to use.
 *
 * An extension owns everything named `ext_<id>_*`, and core happens to keep three
 * tables in the same `ext_` namespace. An id that is a core table name minus a
 * trailing `_`-separated segment therefore claims that core table: `notification`
 * gives the prefix `ext_notification_`, which `ext_notification_subscription`
 * begins with. Uninstalling such an extension would drop a core table — every
 * user's extension notification subscriptions — and its migrations would be
 * allowed to alter it, both of which are the prefix scheme working exactly as
 * designed on an id nobody should have been given.
 *
 * Checked rather than worked around because the alternative fixes are worse: core
 * cannot rename its tables without a migration for every existing install, and
 * an escape hatch in the prefix would have to be understood by the migration
 * guard, the uninstall scan and the entity check independently.
 */
export function reservedExtensionId(id: string): string | undefined {
  const prefix = `ext_${id}_`;

  return coreExtensionTableNames().find((name) => name.startsWith(prefix));
}
