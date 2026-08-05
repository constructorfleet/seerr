/**
 * The `seerr-extension.json` shape, as types.
 *
 * The zod schema in `server/lib/extensions/manifest.ts` is the enforcing
 * authority — it is what actually rejects a bad manifest at discovery, and it
 * checks things no type can (semver validity, cron parseability, `requiresCore`
 * naming a real `Permission`, duplicate keys, panel permissions resolving). What
 * these types add is editor completion while writing the file, and the input to
 * {@link import('./defineExtension').defineExtension}'s capability narrowing.
 *
 * Every field is spelled to match `z.infer<typeof manifestSchema>`;
 * `conformance/hostContract.ts` typechecks the two against each other so a
 * schema change that this file misses fails there.
 */

/**
 * `EXTENSION_ID_PATTERN` is `/^[a-z][a-z0-9-]*$/` and `EXTENSION_KEY_PATTERN` is
 * `/^[a-z][a-z0-9_-]*$/` — ids forbid underscores because they are interpolated
 * into table names, route paths and permission strings; local keys allow them
 * because they sit behind an already-validated id. Neither is expressible as a
 * TypeScript type, so both are plain `string` here and enforced by zod.
 */
export type ExtensionId = string;

/** Access level an extension may declare for a core capability. */
export type ExtensionAccessLevel = 'read' | 'write';

/** The `requires` block: what the SDK handed to this extension will contain. */
export interface ExtensionManifestRequires {
  users?: ExtensionAccessLevel;
  media?: ExtensionAccessLevel;
  requests?: ExtensionAccessLevel;
  /** Read-only; the SDK exposes settings with secrets redacted. */
  settings?: 'read';
  store?: boolean;
  jobs?: boolean;
  /** Outbound hostname allowlist. Advisory in v1 — documented, unenforced. */
  http?: string[];
}

export interface ExtensionManifestPermission {
  key: string;
  name: string;
  description?: string;
  /** Granted to newly created users. */
  default?: boolean;
  /**
   * Core permissions a user must *also* hold for this one to apply, by
   * `Permission` member name. Enforced at check time, not grant time.
   */
  requiresCore?: string[];
}

export interface ExtensionManifestNotification {
  key: string;
  name: string;
  description?: string;
  default?: boolean;
}

export interface ExtensionManifestPanel {
  slug: string;
  title: string;
  /** Relative path to the pre-built ESM bundle. */
  entry: string;
  sidebar?: {
    /** A `@heroicons/react/24/outline` export name, e.g. `ClockIcon`. */
    icon: string;
    order?: number;
  };
  /** An extension permission key, or a core `Permission` member name. */
  permission?: string;
}

export interface ExtensionManifestJob {
  id: string;
  name: string;
  /** A cron expression, validated with `cronstrue` at load time. */
  schedule: string;
}

/** The `provides` block: what this extension contributes to Seerr. */
export interface ExtensionManifestProvides {
  permissions?: ExtensionManifestPermission[];
  notifications?: ExtensionManifestNotification[];
  panels?: ExtensionManifestPanel[];
  jobs?: ExtensionManifestJob[];
}

/**
 * A `seerr-extension.json`.
 *
 * The schema is `z.strictObject`, so an unknown key is a validation failure
 * rather than something ignored.
 */
export interface ExtensionManifest {
  /** Namespaces this extension's tables, routes and permissions. */
  id: ExtensionId;
  name: string;
  /** This extension's own version, a semver version. */
  version: string;
  /**
   * Host SDK compatibility, a semver **range** — `'^1.0.0'`, not `'1.0.0'`.
   * Checked against the host's `HOST_API_VERSION` at discovery; a range the host
   * does not satisfy refuses the extension.
   */
  apiVersion: string;
  description?: string;
  /**
   * Entry point, relative to the extension root. Default-exports
   * `(sdk) => void | Promise<void>`; may also export `entities` and
   * `migrations`, which are read before the DataSource is initialized.
   */
  server: string;
  requires?: ExtensionManifestRequires;
  provides?: ExtensionManifestProvides;
}
