import { cancelExtensionJobs } from '@server/job/extensionJobs';
import type { ExtensionRegistry } from '@server/lib/extensions/registry';
import logger from '@server/logger';

/**
 * Taking a running extension out of service, for the disable endpoint.
 *
 * ## Why this is not a full unload
 *
 * Constraint 4 in docs/specs/extension-system.md: TypeORM builds entity metadata
 * during `dataSource.initialize()` and `entityMetadatas` is readonly afterwards.
 * An extension's entities therefore cannot be injected after boot, so *enabling*
 * one that was off at boot genuinely requires a restart, and always will. Its
 * module also stays in `require.cache`, so re-running an entry point would not
 * re-evaluate it.
 *
 * Disabling has no such obstacle. Everything a running extension contributes —
 * routes, jobs, panels, event listeners — is a list the host owns, and the host
 * can drop its entries. That is what this does, and it is worth doing on its own:
 * "this extension is misbehaving, switch it off" is the case an operator is in
 * when they reach for disable, and "restart your Seerr" is a poor answer to it.
 * The tables the extension created stay behind, which is the same thing that
 * happens when it is disabled at boot.
 *
 * ## Ordering
 *
 * The registry mutation happens *first*, so the extension stops receiving new
 * work before its own teardown runs — a disposer that closes a client must not
 * race a request handler that was admitted a moment later. Disposers then run in
 * reverse registration order, so an extension that acquired A then B releases B
 * then A.
 */
export async function deactivateExtension(
  registry: ExtensionRegistry,
  id: string
): Promise<boolean> {
  const entry = registry.get(id);

  if (!entry || entry.status !== 'active') {
    // Not an error: disabling something that never loaded, or that was
    // quarantined, or that is already off, all leave the operator where they
    // asked to be. The caller reports `deactivated: false` so the UI can still
    // say a restart is what remains.
    return false;
  }

  const disposers = registry.deactivate(id);

  cancelExtensionJobs(id);

  for (const dispose of [...disposers].reverse()) {
    try {
      await dispose();
    } catch (e) {
      // Contained per disposer, and never rethrown: the extension is already out
      // of service by this point, and a teardown that throws must not leave the
      // operator with a failed request for a disable that did in fact happen.
      logger.error('Extension teardown failed', {
        label: 'Extensions',
        extensionId: id,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }

  logger.info(`Deactivated extension "${id}"`, {
    label: 'Extensions',
    disposers: disposers.length,
  });

  return true;
}
