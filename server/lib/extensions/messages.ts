import { containedPath, isContainedIn } from '@server/lib/extensions/paths';
import logger from '@server/logger';
import fs from 'fs/promises';
import path from 'path';

/**
 * Extension-supplied UI strings, resolved for one locale.
 *
 * ## Why the host loads these instead of the panel
 *
 * A panel could fetch its own catalog and build its own `IntlProvider`, and that
 * was the obvious design. It does not work, for two reasons.
 *
 * First, a nested `IntlProvider` *replaces* the message map for its subtree
 * rather than merging into it — and the components a panel renders from
 * `@constructorfleet/extension-ui` are host components that look up *core's* message ids.
 * Scoping a panel that way would leave every button and empty-state label inside
 * it rendering as a raw id. So the catalogs are merged into core's map, which is
 * also why every key is namespaced with the extension id below.
 *
 * Second, a panel bundle is not the only place an extension's strings appear.
 * Its sidebar label and page title are rendered by core, outside the panel and
 * before its bundle has loaded at all. Those cannot be served by anything the
 * panel owns.
 *
 * ## Layout
 *
 * `provides.messages` names a directory of `<locale>.json` files holding flat
 * `key → ICU string` maps, matching core's own catalogs (`src/i18n/locale/`):
 *
 * ```
 * dist/i18n/en.json    { "title": "Watch History", "empty": "Nothing yet" }
 * dist/i18n/de.json    { "title": "Verlauf" }
 * ```
 *
 * A missing, unreadable, or malformed catalog is not an error. It degrades to
 * untranslated — an extension whose build forgot to emit its catalogs should
 * show English ids, not fail to load.
 */

/** The locale every catalog is expected to ship, and the fallback for the rest. */
const FALLBACK_LOCALE = 'en';

/**
 * A locale name that indexes a filename and nothing else.
 *
 * The locale originates in a user setting, which makes it the one input here
 * that a request influences. Rejecting anything outside this shape means a
 * traversal attempt cannot be expressed rather than having to be filtered — the
 * same posture as the panel bundle route.
 */
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;

export interface ExtensionMessageSource {
  id: string;
  /** The extension's own directory. Catalogs must resolve inside it. */
  directory: string;
  /** `provides.messages` — relative to `directory`. Absent means no catalogs. */
  messages?: string;
}

/** A flat `id → ICU string` map, the shape `IntlProvider` takes. */
export type ExtensionMessages = Record<string, string>;

/**
 * Reads one catalog, or returns `undefined` if there is nothing usable there.
 *
 * Every failure is the same answer deliberately: absent file, unreadable file,
 * invalid JSON, and a JSON array all mean "this locale has no catalog", and the
 * caller's fallback chain handles them identically.
 */
async function readCatalog(
  file: string,
  extensionId: string,
  root: string
): Promise<ExtensionMessages | undefined> {
  // The catalog *directory* was checked, but each file in it is a separate
  // symlink target — a `en.json` linked at `../../../../etc/passwd` sits inside a
  // contained directory and would otherwise be read and parsed.
  if (!(await isContainedIn(file, root))) {
    logger.error('Refusing a message catalog outside the extension directory', {
      label: 'Extensions',
      extensionId,
      file,
    });
    return undefined;
  }

  let raw: string;

  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // Logged, unlike a missing file: the extension meant to ship this one and
    // shipped something broken, which the author wants to hear about.
    logger.warn(
      'Ignoring an extension message catalog that is not valid JSON',
      {
        label: 'Extensions',
        extensionId,
        file,
        errorMessage: e instanceof Error ? e.message : String(e),
      }
    );
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger.warn('Ignoring an extension message catalog that is not an object', {
      label: 'Extensions',
      extensionId,
      file,
    });
    return undefined;
  }

  const messages: ExtensionMessages = {};

  for (const [key, value] of Object.entries(parsed)) {
    // Non-strings reach `IntlProvider`, which expects strings; a nested object
    // would be mis-rendered rather than rejected. Dropping keeps the map
    // well-typed at the cost of silently omitting a malformed entry.
    if (typeof value === 'string') {
      messages[key] = value;
    }
  }

  return messages;
}

/**
 * The locales to try, in order, for a requested locale.
 *
 * `pt-BR` tries `pt-BR`, then `pt`, then `en`: core ships regional locales that
 * an extension translated only at the language level, and falling straight to
 * English there would discard a translation that exists. Underscores are tried
 * too because core's own catalog *filenames* use them (`es_MX.json`) while its
 * locale ids use hyphens.
 */
function candidates(locale: string): string[] {
  const found: string[] = [];

  const add = (candidate: string) => {
    if (candidate && !found.includes(candidate)) {
      found.push(candidate);
    }
  };

  add(locale);
  add(locale.replace(/-/g, '_'));

  const [language] = locale.split(/[-_]/);
  add(language);
  add(FALLBACK_LOCALE);

  return found;
}

/**
 * Resolves one extension's strings for `locale`, keyed `<extensionId>.<key>`.
 *
 * English is merged underneath the chosen locale rather than used only when it
 * is missing entirely: a half-translated catalog is the normal state of a
 * translation effort, and without this its untranslated keys would render as
 * raw ids.
 */
export async function loadExtensionMessages({
  id,
  directory,
  messages,
  locale,
}: ExtensionMessageSource & { locale: string }): Promise<ExtensionMessages> {
  if (!messages) {
    return {};
  }

  const root = path.resolve(directory);

  // Re-checked rather than trusted from the manifest schema, for the reason the
  // panel bundle route re-checks its own: this reads files, and a containment
  // guarantee should not depend on an earlier validation having run. `realpath`
  // rather than `path.resolve` arithmetic, so a symlinked catalog directory cannot
  // read outside the extension.
  const catalogs = await containedPath({
    target: path.resolve(root, messages),
    root,
    extensionId: id,
    what: 'a message catalog directory',
  });

  if (!catalogs) {
    return {};
  }

  const wanted = LOCALE_PATTERN.test(locale) ? locale : FALLBACK_LOCALE;
  const resolved: ExtensionMessages = {};

  // Reverse order so the more specific locale overwrites the more general one.
  for (const candidate of candidates(wanted).reverse()) {
    const catalog = await readCatalog(
      path.join(catalogs, `${candidate}.json`),
      id,
      root
    );

    Object.assign(resolved, catalog);
  }

  return Object.fromEntries(
    Object.entries(resolved).map(([key, value]) => [`${id}.${key}`, value])
  );
}

/**
 * Every extension's strings for `locale`, merged into one map.
 *
 * Keys are namespaced per extension, so the merge cannot lose a string to a
 * collision — between two extensions, or with core.
 */
export async function extensionMessageCatalog(
  sources: ExtensionMessageSource[],
  locale: string
): Promise<ExtensionMessages> {
  const loaded = await Promise.all(
    sources.map((source) => loadExtensionMessages({ ...source, locale }))
  );

  return Object.assign({}, ...loaded);
}
