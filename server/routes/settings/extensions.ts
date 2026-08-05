import type { ExtensionFetcher } from '@server/lib/extensions/install';
import {
  ExtensionInstallError,
  fetcherFor,
  installExtension,
  uninstallExtension,
} from '@server/lib/extensions/install';
import { extensionsDirectory } from '@server/lib/extensions/loader';
import { EXTENSION_ID_PATTERN } from '@server/lib/extensions/manifest';
import type { ExtensionRegistry } from '@server/lib/extensions/registry';
import {
  disableExtension,
  enableExtension,
  forgetExtensionSettings,
  isExtensionEnabled,
} from '@server/lib/extensions/settings';
import logger from '@server/logger';
import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';

/**
 * Admin endpoints for the installed extensions.
 *
 * Mounted under `/api/v1/settings`, which `server/routes/index.ts` gates on
 * `isAuthenticated(Permission.ADMIN)` — these are fixed core paths, documented in
 * `seerr-api.yml` like any other, and validated by the OpenAPI validator. That is
 * the difference between these and an extension's *own* routes, which are mounted
 * ahead of the validator because their paths cannot be known in advance.
 *
 * Nothing here loads or unloads an extension in the running process. Entities have
 * to be injected before `dataSource.initialize()` (Constraint 4 in
 * docs/specs/extension-system.md), so installing, enabling and disabling all take
 * effect on the next start — which is why each response carries
 * `restartRequired`.
 */
const extensionSettingsRoutes = Router();

/**
 * The registry boot produced, so the list endpoint can report what actually
 * loaded. Set by `server/index.ts`; absent means "no extensions loaded", which is
 * the truth before boot has wired it and in a test that has not set one.
 */
let liveRegistry: ExtensionRegistry | undefined;

export function setExtensionRegistry(
  registry: ExtensionRegistry | undefined
): void {
  liveRegistry = registry;
}

/** Overrides for tests: an injected install directory and fetch step. */
let installDirectory: string | undefined;
let installer: ((source: string) => ExtensionFetcher) | undefined;

export function setExtensionInstallDirectory(
  directory: string | undefined
): void {
  installDirectory = directory;
}

export function setExtensionInstaller(
  fetch: ((source: string) => ExtensionFetcher) | undefined
): void {
  installer = fetch;
}

function directory(): string {
  return installDirectory ?? extensionsDirectory();
}

/** What the admin UI reads: registry health plus the operator's own setting. */
extensionSettingsRoutes.get('/', async (_req, res, next) => {
  try {
    const health = liveRegistry?.health() ?? [];
    const known = new Set(health.map((entry) => entry.id));

    // An extension installed since this process started has no registry entry at
    // all. Reported as `pending` rather than omitted, because "installed, not yet
    // loaded" is exactly the state a restart resolves, and omitting it would make
    // a successful install look like it had done nothing.
    const unloaded = (await installedIds()).filter((id) => !known.has(id));

    res.status(200).json([
      ...health.map((entry) => ({
        ...entry,
        enabled: isExtensionEnabled(entry.id),
      })),
      ...unloaded.map((id) => ({
        id,
        status: 'pending' as const,
        enabled: isExtensionEnabled(id),
      })),
    ]);
  } catch (e) {
    next(e);
  }
});

extensionSettingsRoutes.post('/', async (req, res, next) => {
  const source = typeof req.body?.source === 'string' ? req.body.source : '';

  if (!source.trim()) {
    return next({
      status: 400,
      message: 'An npm package name or git repository URL is required.',
    });
  }

  try {
    const result = await installExtension({
      source,
      directory: directory(),
      fetch: (installer ?? fetcherFor)(source),
    });

    return res.status(201).json({
      id: result.id,
      name: result.manifest.name,
      version: result.manifest.version,
      replaced: result.replaced,
      restartRequired: true,
    });
  } catch (e) {
    if (e instanceof ExtensionInstallError) {
      // The operator's own input was wrong, or the package was: either way the
      // message is the useful part, and it is safe to show because every one of
      // them is written by the installer rather than by extension code.
      return next({ status: 400, message: e.message });
    }

    logger.error('Extension install failed unexpectedly', {
      label: 'Extensions',
      source,
      errorMessage: e instanceof Error ? e.message : String(e),
    });

    return next(e);
  }
});

extensionSettingsRoutes.delete('/:extensionId', async (req, res, next) => {
  const { extensionId } = req.params;
  const purgeData = req.query.purgeData === 'true';

  try {
    if (!EXTENSION_ID_PATTERN.test(extensionId)) {
      // Checked before the existence probe so that a malformed id is reported as
      // malformed rather than as merely absent.
      return next({
        status: 400,
        message: `"${extensionId}" is not a valid extension id.`,
      });
    }

    if (!(await isInstalled(extensionId))) {
      return next({
        status: 404,
        message: `No extension "${extensionId}" is installed.`,
      });
    }

    await uninstallExtension({
      id: extensionId,
      directory: directory(),
      purgeData,
    });

    // The enable setting goes even when data is kept: it describes an install the
    // operator has just removed, and leaving it would mean a reinstall of
    // something previously switched off installs successfully and then silently
    // does not load. Permission and subscription rows are different — see
    // `uninstallExtension`.
    await forgetExtensionSettings(extensionId);

    return res.status(204).send();
  } catch (e) {
    if (e instanceof ExtensionInstallError) {
      return next({ status: 400, message: e.message });
    }

    return next(e);
  }
});

for (const [action, apply] of [
  ['enable', enableExtension],
  ['disable', disableExtension],
] as const) {
  extensionSettingsRoutes.post(
    `/:extensionId/${action}`,
    async (req, res, next) => {
      const { extensionId } = req.params;

      try {
        if (!(await isInstalled(extensionId))) {
          return next({
            status: 404,
            message: `No extension "${extensionId}" is installed.`,
          });
        }

        await apply(extensionId);

        return res.status(200).json({
          id: extensionId,
          enabled: action === 'enable',
          restartRequired: true,
        });
      } catch (e) {
        return next(e);
      }
    }
  );
}

/**
 * Whether a directory for this id exists.
 *
 * Checked against the filesystem rather than the registry, because the registry
 * only knows what this process discovered at boot: an extension installed a minute
 * ago is absent from it, and one that failed to load is present but must still be
 * uninstallable.
 */
async function isInstalled(extensionId: string): Promise<boolean> {
  if (path.basename(extensionId) !== extensionId) {
    // `uninstallExtension` validates the id properly; this only keeps a traversal
    // out of the existence check that runs first.
    return false;
  }

  try {
    await fs.access(path.join(directory(), extensionId));
    return true;
  } catch {
    return false;
  }
}

async function installedIds(): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory(), { withFileTypes: true });

    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith('.'))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    // Nothing installed is the default state, not an error.
    return [];
  }
}

export default extensionSettingsRoutes;
