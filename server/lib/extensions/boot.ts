import { scheduleExtensionJobs } from '@server/job/extensionJobs';
import { setExtensionEventSource } from '@server/lib/extensions/events';
import type { DiscoverExtensionsOptions } from '@server/lib/extensions/loader';
import {
  activateExtensions,
  discoverExtensions,
  injectExtensionEntities,
} from '@server/lib/extensions/loader';
import { setExtensionPermissionRegistry } from '@server/lib/extensions/permissions';
import { ExtensionRegistry } from '@server/lib/extensions/registry';
import logger from '@server/logger';
import type { DataSource, DataSourceOptions } from 'typeorm';

/**
 * **Phase A**, for `server/index.ts`: discovery, plus injecting the discovered
 * entities into a DataSource.
 *
 * Must be called *before* `dataSource.initialize()`. TypeORM builds entity
 * metadata during initialization and `entityMetadatas` is readonly afterwards, so
 * an entity registered later never gets a table — which is why discovery does no
 * database access at all and is a separate phase from activation.
 *
 * Never rejects. A broken extension is quarantined inside the registry it
 * returns; boot continues either way.
 */
export async function discoverExtensionsForBoot(
  options: DiscoverExtensionsOptions & { dataSource?: DataSource } = {}
): Promise<ExtensionRegistry> {
  const { dataSource, ...discoverOptions } = options;

  try {
    const registry = await discoverExtensions(discoverOptions);

    if (dataSource) {
      injectExtensionEntities(dataSource, registry);
    }

    return registry;
  } catch (e) {
    // `discoverExtensions` quarantines per extension and does not reject, so
    // reaching this is a bug in the loader rather than a broken extension. Boot
    // proceeds with no extensions rather than not at all.
    logger.error('Extension discovery failed; continuing without extensions', {
      label: 'Extensions',
      errorMessage: e instanceof Error ? e.message : String(e),
    });

    return new ExtensionRegistry();
  }
}

/**
 * **Phase B**, for `server/index.ts`: runs each extension's migrations and entry
 * point, then wires what they registered into core — permissions, jobs and the
 * event bus. Routes are mounted separately, by `createExtensionRouter`.
 *
 * Must be called *after* `dataSource.initialize()`, since the SDK hands out live
 * repositories.
 *
 * Never rejects. A failed extension is quarantined and contributes nothing; boot
 * is never fatal on account of an extension.
 */
export async function activateDiscoveredExtensions(
  registry: ExtensionRegistry,
  dataSource: DataSource
): Promise<void> {
  try {
    await activateExtensions(registry, {
      migrationBaseOptions: dataSource.options,
      // `synchronize: true` (dev and test) has already created the extension's
      // tables from the entities discovery injected, so its migrations would run
      // against tables that exist and quarantine it on every boot.
      runMigrations: !isSynchronized(dataSource.options),
    });
  } catch (e) {
    logger.error('Extension activation failed; continuing without extensions', {
      label: 'Extensions',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
  }

  // Wired after activation, and from the registry rather than from a list, so
  // only extensions that actually activated contribute. Each of these is
  // independently guarded: none of them may take down the boot.
  wire('the permission resolver', () =>
    setExtensionPermissionRegistry(registry)
  );
  wire('the event bus', () => setExtensionEventSource(registry));
  wire('scheduled jobs', () => scheduleExtensionJobs(registry));
}

function wire(what: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    logger.error(`Failed to wire extensions into ${what}`, {
      label: 'Extensions',
      errorMessage: e instanceof Error ? e.message : String(e),
    });
  }
}

function isSynchronized(options: DataSourceOptions): boolean {
  return options.synchronize === true;
}
