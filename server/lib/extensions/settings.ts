import type { ExtensionSettings } from '@server/lib/settings';
import { SETTINGS_PATH, getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import fs from 'fs/promises';

/**
 * The persisted enable/disable state for installed extensions, and the resolver
 * that `discoverExtensions` reads it through.
 *
 * Kept in `settings.json` (see {@link ExtensionSettings}) because discovery runs
 * before the DataSource is initialized. Kept in its own module rather than in
 * `settings/index.ts` because the semantics — absent means enabled, uninstall
 * forgets — are extension-system decisions, not settings plumbing.
 */

/** Every recorded setting, keyed by extension id. */
export function extensionSettings(): Record<string, ExtensionSettings> {
  return getSettings().extensions;
}

/**
 * Whether the operator has this extension switched on.
 *
 * An extension with nothing recorded is enabled. Installing is already an
 * explicit admin action, so there is nothing to confirm afterwards, and it means
 * an existing install upgraded into a Seerr that has this setting keeps loading
 * exactly what it loaded before.
 */
export function isExtensionEnabled(id: string): boolean {
  return getSettings().extensions[id]?.enabled ?? true;
}

export async function enableExtension(id: string): Promise<void> {
  await setEnabled(id, true);
}

export async function disableExtension(id: string): Promise<void> {
  await setEnabled(id, false);
}

async function setEnabled(id: string, enabled: boolean): Promise<void> {
  const settings = getSettings();

  settings.extensions = {
    ...settings.extensions,
    [id]: { ...settings.extensions[id], enabled },
  };

  await settings.save();
}

/**
 * Drops an extension's recorded settings, so that reinstalling something that was
 * disabled comes back enabled rather than installing successfully and then
 * silently not loading.
 *
 * Deliberately unlike the treatment of its permission rows, which uninstall
 * keeps: a grant is a decision about *users* and stays meaningful across
 * versions, whereas "switched off" is a decision about a specific install that
 * the operator has just replaced.
 */
export async function forgetExtensionSettings(id: string): Promise<void> {
  const settings = getSettings();

  if (!(id in settings.extensions)) {
    return;
  }

  const remaining = { ...settings.extensions };
  delete remaining[id];
  settings.extensions = remaining;

  await settings.save();
}

/**
 * The `isEnabled` callback for `discoverExtensions`.
 *
 * Reads the setting per call rather than capturing it, so a change made through
 * the API is picked up without anything having to rebuild the resolver.
 */
export function extensionEnabledResolver(): (id: string) => boolean {
  return (id) => isExtensionEnabled(id);
}

/**
 * Reads the enable/disable state straight off disk, for use *before* boot has
 * loaded settings.
 *
 * Discovery has to run before `dataSource.initialize()`, which in
 * `server/index.ts` is before `getSettings().load()`, so the singleton still
 * holds constructor defaults at the moment discovery asks whether an extension is
 * enabled. Read as a file rather than through `Settings.load`, which generates
 * missing keys and writes them back — a side effect that has no business
 * happening this early, and which would race the real `load()` a few lines later.
 *
 * A missing or unreadable file means "enable everything present", which is the
 * state of a fresh install.
 */
export async function loadExtensionEnabledResolver(): Promise<
  (id: string) => boolean
> {
  let recorded: Record<string, ExtensionSettings> = {};

  try {
    const raw = JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf-8'));
    recorded = raw?.extensions ?? {};
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') {
      logger.warn(
        'Could not read extension settings; enabling all extensions',
        {
          label: 'Extensions',
          errorMessage: e instanceof Error ? e.message : String(e),
        }
      );
    }
  }

  return (id) => recorded[id]?.enabled ?? true;
}
