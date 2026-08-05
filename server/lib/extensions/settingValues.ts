import type { ExtensionManifestSetting } from '@server/lib/extensions/manifest';
import { settingValueMatchesType } from '@server/lib/extensions/manifest';
import type { ExtensionRegistry } from '@server/lib/extensions/registry';
import type {
  ExtensionSettingValue,
  ExtensionSettings,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';

/**
 * Values for the settings an extension declares in `provides.settings` — the
 * operator's side of the manifest's typed schema.
 *
 * ## Where these live, and why
 *
 * In `settings.json`, under `settings.extensions[id].values`, beside `enabled`.
 * The alternative was `ext_kv`, which is already a per-extension namespaced
 * table, and it was rejected for two reasons:
 *
 * - `requires.store` is **optional**. An extension may declare settings and never
 *   ask for storage, and `ext_kv` is the store capability's table — putting the
 *   host's own operator state there would mean either granting an implicit store
 *   to anything with a setting, or reading a table through a path that bypasses
 *   the capability it belongs to.
 * - `ext_kv` is *the extension's* storage. These values are not the extension's
 *   data; they are the operator's configuration of it, in the same category as
 *   `enabled`, and an extension that could rewrite them through `sdk.store.kv`
 *   would be editing the form behind the operator's back.
 *
 * The cost is that a `secret` sits in a file the operator can read. That is
 * already true of core's own `apiKey` in the same file, so it changes nothing
 * about the threat model; redaction exists to keep secrets out of the *browser*.
 *
 * ## What happens on uninstall
 *
 * They are dropped, by `forgetExtensionSettings` — which deletes
 * `settings.extensions[id]` whole, values included, and which `DELETE
 * /:extensionId` already calls. That is deliberate rather than incidental, and it
 * follows `enabled` rather than the permission rows: a permission grant is a
 * decision about *users* and stays meaningful across versions, whereas these
 * values configure one specific install. A stale `endpoint` or an old credential
 * silently back in effect after a reinstall is worse than an empty form.
 *
 * {@link clearExtensionSettingValues} exists for "reset this extension's
 * configuration" without touching its enable state, which is a distinct operator
 * action from uninstalling.
 */

/** Resolves the settings one extension declares, by id. */
export type SettingDeclarationProvider = (
  extensionId: string
) => ExtensionManifestSetting[];

let provideDeclarations: SettingDeclarationProvider = () => [];

/**
 * The sentinel a set `secret` is reported as, and which a caller may submit back
 * to mean "leave it as it is".
 *
 * A fixed string rather than a boolean, so the same field type round-trips
 * through the form: the client renders whatever it was given and submits it back
 * unchanged unless the operator typed something. See
 * {@link updateExtensionSettingValues} for the preserve/clear rules.
 */
export const REDACTED_SECRET = '********';

/** Injection point for tests and for `server/index.ts`'s live registry. */
export function setExtensionSettingDeclarations(
  provider: SettingDeclarationProvider
): void {
  provideDeclarations = provider;
}

/** Wires the resolver to a live registry, for `server/index.ts`. */
export function setExtensionSettingRegistry(registry: ExtensionRegistry): void {
  setExtensionSettingDeclarations((extensionId) => {
    const entry = registry
      .all()
      .find(
        (candidate) =>
          candidate.id === extensionId &&
          (candidate.status === 'pending' || candidate.status === 'active')
      );

    return entry?.manifest?.provides?.settings ?? [];
  });
}

/** The settings `extensionId` declares, or `[]` if it declares none. */
export function getExtensionSettingDeclarations(
  extensionId: string
): ExtensionManifestSetting[] {
  return provideDeclarations(extensionId);
}

/** Values as stored, before defaults and before the declarations are consulted. */
function storedValues(extensionId: string): Record<string, unknown> {
  return getSettings().extensions[extensionId]?.values ?? {};
}

/**
 * Every declared setting's current value, with defaults applied — the view an
 * extension reads through `sdk.settings.own`, secrets included.
 *
 * A key with no saved value and no declared default is **absent** rather than
 * present-and-undefined, so `'endpoint' in values` distinguishes "the operator
 * has not configured this" from "the operator saved an empty string". That is the
 * check a `required` setting's extension makes before it tries to work.
 *
 * A stored value the declarations no longer admit — an unknown key, or one whose
 * type the extension changed in an upgrade — is skipped rather than handed over.
 * It stays on disk, so downgrading recovers it, but an extension expecting a
 * `number` never receives the `string` an older version saved.
 */
export function getExtensionSettingValues(
  extensionId: string
): Record<string, ExtensionSettingValue> {
  const stored = storedValues(extensionId);
  const values: Record<string, ExtensionSettingValue> = {};

  for (const declared of provideDeclarations(extensionId)) {
    const saved = stored[declared.key];

    if (settingValueMatchesType(declared.type, saved)) {
      values[declared.key] = saved as ExtensionSettingValue;
    } else if (declared.default !== undefined) {
      values[declared.key] = declared.default;
    }
  }

  return values;
}

/**
 * The same values, safe to send to a browser: a `secret` that is set reports
 * {@link REDACTED_SECRET}, and one that is not is absent.
 *
 * Absent rather than an empty string, because the form has to render "configured,
 * leave it alone" differently from "nothing here yet" — and because an empty
 * string submitted back is how the operator says "no change", which would be
 * indistinguishable from the unset state.
 */
export function getRedactedExtensionSettingValues(
  extensionId: string
): Record<string, ExtensionSettingValue> {
  const values = getExtensionSettingValues(extensionId);
  const secrets = provideDeclarations(extensionId).filter(
    (declared) => declared.type === 'secret'
  );

  for (const secret of secrets) {
    if (secret.key in values) {
      values[secret.key] = REDACTED_SECRET;
    }
  }

  return values;
}

/** Thrown when a submitted update does not match the declared schema. */
export class ExtensionSettingValueError extends Error {
  /** The declared key the failure is about, for a field-level form error. */
  public readonly key: string;

  constructor(key: string, message: string) {
    super(message);
    this.name = 'ExtensionSettingValueError';
    this.key = key;
  }
}

/**
 * Applies a partial update, validated against the declarations.
 *
 * Partial by design: the admin form submits the fields it rendered, and a key
 * left out keeps whatever it had. Validated as a whole before anything is
 * written, so a submission with one bad field changes nothing rather than
 * applying half of itself.
 *
 * ## Secrets
 *
 * A `secret` submitted as {@link REDACTED_SECRET} or as `''` means **leave
 * unchanged**. It has to: the client is never given the real value, so it renders
 * the sentinel and submits it back on every save — reading that as a new value
 * would overwrite the credential with asterisks the first time the operator
 * changed an unrelated field. The consequence is that a save can never *clear* a
 * secret; {@link clearExtensionSettingValue} is the explicit way, which the form
 * surfaces as its own control.
 *
 * @throws {ExtensionSettingValueError} for an undeclared key, a value of the
 * wrong type, a `select` value outside its options, or a number outside its
 * bounds.
 */
export async function updateExtensionSettingValues(
  extensionId: string,
  update: Record<string, ExtensionSettingValue>
): Promise<void> {
  const declarations = new Map(
    provideDeclarations(extensionId).map((declared) => [declared.key, declared])
  );
  const stored = storedValues(extensionId);
  const applied: Record<string, ExtensionSettingValue> = {};

  for (const [key, value] of Object.entries(update)) {
    const declared = declarations.get(key);

    if (!declared) {
      throw new ExtensionSettingValueError(
        key,
        `Extension "${extensionId}" does not declare a setting "${key}".`
      );
    }

    if (
      declared.type === 'secret' &&
      (value === REDACTED_SECRET || value === '')
    ) {
      continue;
    }

    assertValid(declared, value);
    applied[key] = value;
  }

  if (!Object.keys(applied).length) {
    // Nothing left after the secret no-ops, so there is no reason to rewrite
    // `settings.json` — a form saved with no changes should not touch the file.
    return;
  }

  await writeValues(extensionId, { ...stored, ...applied });
}

function assertValid(
  declared: ExtensionManifestSetting,
  value: ExtensionSettingValue
): void {
  if (!settingValueMatchesType(declared.type, value)) {
    throw new ExtensionSettingValueError(
      declared.key,
      `"${declared.key}" is not a ${declared.type}.`
    );
  }

  if (
    declared.options &&
    !declared.options.some((option) => option.value === value)
  ) {
    throw new ExtensionSettingValueError(
      declared.key,
      `"${declared.key}" is not one of its declared options.`
    );
  }

  if (typeof value !== 'number') {
    return;
  }

  if (declared.min !== undefined && value < declared.min) {
    throw new ExtensionSettingValueError(
      declared.key,
      `"${declared.key}" is below the minimum of ${declared.min}.`
    );
  }

  if (declared.max !== undefined && value > declared.max) {
    throw new ExtensionSettingValueError(
      declared.key,
      `"${declared.key}" is above the maximum of ${declared.max}.`
    );
  }
}

/**
 * Forgets one saved value, so the declared default (if any) applies again.
 *
 * This is the only way to unset a `secret` — a save cannot, since the sentinel
 * and the empty string both mean "no change".
 *
 * @throws {ExtensionSettingValueError} if the extension does not declare `key`.
 */
export async function clearExtensionSettingValue(
  extensionId: string,
  key: string
): Promise<void> {
  const declared = provideDeclarations(extensionId).some(
    (candidate) => candidate.key === key
  );

  if (!declared) {
    throw new ExtensionSettingValueError(
      key,
      `Extension "${extensionId}" does not declare a setting "${key}".`
    );
  }

  const stored = storedValues(extensionId);

  if (!(key in stored)) {
    return;
  }

  const remaining = { ...stored };
  delete remaining[key];

  await writeValues(extensionId, remaining);
}

/**
 * Drops every saved value, for uninstall.
 *
 * Called beside `forgetExtensionSettings` rather than folded into it, so that
 * "forget the enable state" and "forget the configuration" stay separately
 * callable — but note both happen on uninstall, deliberately: see the note at
 * the top of this module.
 */
export async function clearExtensionSettingValues(
  extensionId: string
): Promise<void> {
  if (!getSettings().extensions[extensionId]?.values) {
    return;
  }

  await writeValues(extensionId, {});
}

/**
 * Persists `values`, preserving whatever else is recorded for the extension.
 *
 * An empty record removes the key entirely rather than storing `{}`, so
 * `settings.json` does not accumulate empty objects for every extension whose
 * form was opened and saved unchanged.
 */
async function writeValues(
  extensionId: string,
  values: Record<string, unknown>
): Promise<void> {
  const settings = getSettings();
  const existing = settings.extensions[extensionId];
  const recorded: ExtensionSettings = {
    ...existing,
    // Defaulted to true for the same reason `isExtensionEnabled` does: an
    // extension with nothing recorded is on, and saving a setting must not be the
    // thing that decides otherwise.
    enabled: existing?.enabled ?? true,
  };

  if (Object.keys(values).length) {
    recorded.values = values as Record<string, ExtensionSettingValue>;
  } else {
    delete recorded.values;
  }

  settings.extensions = { ...settings.extensions, [extensionId]: recorded };

  await settings.save();
}
