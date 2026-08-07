import { reservedExtensionId } from '@server/lib/extensions/coreTables';
import { PANEL_ICON_NAMES } from '@server/lib/extensions/panelIcons';
import { Permission } from '@server/lib/permissions';
import cronstrue from 'cronstrue';
import semver from 'semver';
import { z } from 'zod';

/**
 * Identifier pattern for an extension. `id` prefixes table names
 * (`ext_<id>_*`), URL segments (`/api/v1/ext/<id>`), and permission keys
 * (`<id>:<key>`), none of which are parameterized, so this validation is the
 * only thing standing between a manifest and a schema/route injection.
 */
export const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Pattern for the local keys an extension namespaces under its id: permission
 * keys, notification keys, panel slugs, and job ids. Underscores are allowed
 * where `EXTENSION_ID_PATTERN` forbids them, because the documented keys use
 * them (`view_own`); everything else is as conservative as the id.
 */
export const EXTENSION_KEY_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** Core `Permission` members an extension may name in `requiresCore`. */
const corePermissionNames = new Set(
  Object.keys(Permission).filter(
    // Numeric enums carry a reverse mapping, and NONE would grant
    // unconditionally (`hasPermission` returns true for it).
    (name) => isNaN(Number(name)) && name !== 'NONE'
  )
);

const extensionId = z
  .string()
  .regex(
    EXTENSION_ID_PATTERN,
    'must be lowercase alphanumeric with hyphens, starting with a letter'
  )
  .superRefine((value, ctx) => {
    // Core keeps three tables of its own in the `ext_` namespace, so an id that
    // is one of their names minus a trailing segment claims a core table through
    // its `ext_<id>_` prefix — see `reservedExtensionId`.
    const reserved = reservedExtensionId(value);

    if (reserved) {
      ctx.addIssue({
        code: 'custom',
        message: `must not be "${value}", whose "ext_${value}_" table prefix claims the core table "${reserved}"`,
      });
    }
  });

const extensionKey = z
  .string()
  .regex(
    EXTENSION_KEY_PATTERN,
    'must be lowercase alphanumeric with hyphens or underscores, starting with a letter'
  );

const semverVersion = z
  .string()
  .refine((value) => semver.valid(value) !== null, 'must be a semver version');

const semverRange = z
  .string()
  // `semver.validRange('')` is `*`, which would silently make an extension
  // compatible with every host SDK, so the emptiness check is not redundant.
  .min(1)
  .refine(
    (value) => semver.validRange(value) !== null,
    'must be a semver range'
  );

/**
 * A path to a file inside the extension's own directory. Rejects absolute
 * paths, parent-directory escapes, and Windows separators so a manifest cannot
 * point the loader outside the directory it was installed into.
 */
const relativeFilePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.split('/').includes('..'),
    'must be a relative path inside the extension directory'
  );

/** A bare hostname, optionally wildcarded at the leftmost label. */
const hostname = z
  .string()
  .regex(
    /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/,
    'must be a bare hostname, without a scheme or path'
  );

/**
 * A name the sidebar can actually render — see `./panelIcons`, which is also
 * what keys the renderer's map, so the two cannot disagree.
 *
 * An enum rather than the `/^[A-Z][A-Za-z0-9]*Icon$/` shape check this used to
 * be. Shape alone let a real heroicon that the renderer had no import for
 * validate and install, and the only symptom was the generic puzzle-piece
 * fallback appearing in the sidebar. Naming the closed set means the manifest
 * error says so at install time, and lists the alternatives.
 */
const heroicon = z.enum(PANEL_ICON_NAMES, {
  message: `must be one of: ${PANEL_ICON_NAMES.join(', ')}`,
});

const cronSchedule = z.string().refine((value) => {
  try {
    // cronstrue rejects malformed expressions by throwing (a string, not an
    // Error), and is already a dependency for describing core's job schedules.
    cronstrue.toString(value);
    return true;
  } catch {
    return false;
  }
}, 'must be a cron expression');

const accessLevel = z.enum(['read', 'write']);

const requiresSchema = z.strictObject({
  users: accessLevel.optional(),
  media: accessLevel.optional(),
  requests: accessLevel.optional(),
  // The SDK exposes settings read-only, with secrets redacted; there is no
  // write form to ask for.
  settings: z.literal('read').optional(),
  // Likewise read-only: `discover` is TMDB lookups through core's cached,
  // rate-limited client. Nothing there is writable, so a `'write'` level would
  // name a capability that cannot exist.
  discover: z.literal('read').optional(),
  // Read-only for a third reason: `tautulli` is *watch history*, which Tautulli
  // itself derives from Plex sessions. There is nothing an extension could write
  // there that Tautulli would not overwrite from the media server on its next
  // scan, so a `'write'` level would name a capability that cannot exist.
  tautulli: z.literal('read').optional(),
  store: z.boolean().optional(),
  jobs: z.boolean().optional(),
  /** Outbound allowlist. Advisory in v1 — documented, unenforced. */
  http: z.array(hostname).optional(),
  /**
   * React versions this extension's panels work with, checked against the
   * version the host actually ships.
   *
   * Unlike the other keys here this asks for nothing — it is a compatibility
   * assertion, not a capability. It lives in this block because it is the same
   * kind of statement as `apiVersion`, one level down: panels are handed the
   * *host's* React through the import map (`sharedModuleSpecifiers.ts`) so that
   * hooks work at all, which means a panel built against a different major gets
   * the host's copy regardless and fails somewhere that never mentions React.
   *
   * Optional, and only meaningful for an extension with panels.
   */
  react: semverRange.optional(),
});

const permissionSchema = z.strictObject({
  key: extensionKey,
  name: z.string().min(1),
  description: z.string().optional(),
  /** Granted to newly created users. */
  default: z.boolean().optional(),
  /** Core permissions a user must also hold for this one to apply. */
  requiresCore: z
    .array(
      z.string().superRefine((value, ctx) => {
        if (!corePermissionNames.has(value)) {
          ctx.addIssue({
            code: 'custom',
            message: `"${value}" is not a core Permission`,
          });
        }
      })
    )
    .optional(),
});

const notificationSchema = z.strictObject({
  key: extensionKey,
  name: z.string().min(1),
  description: z.string().optional(),
  default: z.boolean().optional(),
});

const panelSchema = z.strictObject({
  slug: extensionKey,
  title: z.string().min(1),
  entry: relativeFilePath,
  sidebar: z
    .strictObject({
      icon: heroicon,
      order: z.number().int().optional(),
    })
    .optional(),
  /** An extension permission key, or a core `Permission` member name. */
  permission: z.string().min(1).optional(),
});

const jobSchema = z.strictObject({
  id: extensionKey,
  name: z.string().min(1),
  schedule: cronSchedule,
});

/** The field kinds the host knows how to render a form control for. */
export const EXTENSION_SETTING_TYPES = [
  'boolean',
  'string',
  'number',
  'select',
  'secret',
] as const;

export type ExtensionSettingType = (typeof EXTENSION_SETTING_TYPES)[number];

/**
 * Whether `value` is a legal value for a setting declared as `type`.
 *
 * Shared by the manifest schema (checking a declared `default`) and by
 * `settingsValues.ts` (checking what an operator submits), so the two cannot
 * disagree about what `type: 'number'` accepts. `select` and `secret` are strings
 * — a `select` value is one of its `options[].value`, which the schema and the
 * write path check separately, because only they know the option list.
 */
export function settingValueMatchesType(
  type: ExtensionSettingType,
  value: unknown
): boolean {
  switch (type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      // Finite, because `NaN` and `Infinity` survive `JSON.parse` of nothing but
      // would round-trip through `settings.json` as `null`.
      return typeof value === 'number' && Number.isFinite(value);
    default:
      return typeof value === 'string';
  }
}

const settingOptionSchema = z.strictObject({
  value: z.string().min(1),
  label: z.string().min(1),
});

/**
 * One operator-editable setting. The extension declares the shape; the host
 * renders the form and owns the value, so nothing here is a hint the extension
 * can choose to ignore.
 */
const settingSchema = z
  .strictObject({
    key: extensionKey,
    type: z.enum(EXTENSION_SETTING_TYPES),
    // `name`, matching `permissionSchema` and `notificationSchema`. The nested
    // `options[].label` stays a label: that one really is a choice's display
    // text, not the thing's name.
    name: z.string().min(1),
    description: z.string().optional(),
    /** Used when the operator has never saved this key. */
    default: z.union([z.boolean(), z.string(), z.number()]).optional(),
    /** Required for, and only valid for, `type: 'select'`. */
    options: z.array(settingOptionSchema).min(1).optional(),
    /** Whether the extension needs a value to function. Advisory: the host
     * surfaces it in the form, and does not refuse a partial save over it. */
    required: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .superRefine((setting, ctx) => {
    if (setting.type === 'secret' && setting.default !== undefined) {
      // A default credential ships in the extension's manifest — world-readable
      // in the install directory, identical across every install, and silently
      // in effect for any operator who never opens the form. Refused rather than
      // warned about, because the failure mode is a working extension nobody
      // realises is authenticating as someone else.
      ctx.addIssue({
        code: 'custom',
        path: ['default'],
        message: 'a secret must not declare a default',
      });
    }

    if (setting.type === 'select' && !setting.options) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'a select must declare options',
      });
    }

    if (setting.type !== 'select' && setting.options) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: `options are only valid for a select, not "${setting.type}"`,
      });
    }

    for (const bound of ['min', 'max'] as const) {
      if (setting[bound] !== undefined && setting.type !== 'number') {
        ctx.addIssue({
          code: 'custom',
          path: [bound],
          message: `${bound} is only valid for a number, not "${setting.type}"`,
        });
      }
    }

    if (
      setting.min !== undefined &&
      setting.max !== undefined &&
      setting.min > setting.max
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['max'],
        message: `max ${setting.max} is below min ${setting.min}`,
      });
    }

    if (setting.default === undefined) {
      return;
    }

    if (!settingValueMatchesType(setting.type, setting.default)) {
      ctx.addIssue({
        code: 'custom',
        path: ['default'],
        message: `default ${JSON.stringify(setting.default)} is not a ${setting.type}`,
      });

      return;
    }

    // Checked here rather than in `settingValueMatchesType`, which has no option
    // list: a default outside the options renders as a form with nothing
    // selected, or as a value the operator cannot re-choose after changing it.
    if (
      setting.options &&
      !setting.options.some((option) => option.value === setting.default)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['default'],
        message: `default ${JSON.stringify(setting.default)} is not one of the declared options`,
      });
    }

    // A default outside its own bounds renders a form the operator cannot submit
    // without first changing the value — and one that was never opened is sitting
    // on a number the extension declared out of range.
    if (typeof setting.default !== 'number') {
      return;
    }

    if (setting.min !== undefined && setting.default < setting.min) {
      ctx.addIssue({
        code: 'custom',
        path: ['default'],
        message: `default ${setting.default} is below min ${setting.min}`,
      });
    }

    if (setting.max !== undefined && setting.default > setting.max) {
      ctx.addIssue({
        code: 'custom',
        path: ['default'],
        message: `default ${setting.default} is above max ${setting.max}`,
      });
    }
  });

const providesSchema = z.strictObject({
  permissions: z.array(permissionSchema).optional(),
  notifications: z.array(notificationSchema).optional(),
  panels: z.array(panelSchema).optional(),
  jobs: z.array(jobSchema).optional(),
  settings: z.array(settingSchema).optional(),
  /**
   * Directory of `<locale>.json` UI string catalogs — see `./messages`.
   *
   * Extension-wide rather than per-panel: a sidebar label and a page title are
   * rendered by core, outside any panel, so a catalog scoped to one panel could
   * not translate them.
   */
  messages: relativeFilePath.optional(),
});

/**
 * Reports every key that appears more than once in `values`. Keys are
 * namespaced as `<extensionId>:<key>` (or become a URL segment, for panels), so
 * a duplicate is an ambiguous reference rather than a harmless repetition.
 */
function addDuplicateIssues(
  ctx: z.RefinementCtx,
  values: readonly string[] | undefined,
  path: (string | number)[],
  field: string
): void {
  const seen = new Set<string>();

  values?.forEach((value, index) => {
    if (seen.has(value)) {
      ctx.addIssue({
        code: 'custom',
        path: [...path, index, field],
        message: `Duplicate ${field} "${value}"`,
      });
    }
    seen.add(value);
  });
}

export const manifestSchema = z
  .strictObject({
    id: extensionId,
    name: z.string().min(1),
    version: semverVersion,
    /** Host SDK compatibility, checked with `semver` at load time. */
    apiVersion: semverRange,
    description: z.string().optional(),
    /** Entry point; default-exports `(sdk) => void | Promise<void>`. */
    server: relativeFilePath,
    requires: requiresSchema.optional(),
    provides: providesSchema.optional(),
  })
  .superRefine((manifest, ctx) => {
    const { permissions, notifications, panels, jobs, settings } =
      manifest.provides ?? {};

    addDuplicateIssues(
      ctx,
      permissions?.map((permission) => permission.key),
      ['provides', 'permissions'],
      'key'
    );
    addDuplicateIssues(
      ctx,
      notifications?.map((notification) => notification.key),
      ['provides', 'notifications'],
      'key'
    );
    addDuplicateIssues(
      ctx,
      panels?.map((panel) => panel.slug),
      ['provides', 'panels'],
      'slug'
    );
    addDuplicateIssues(
      ctx,
      jobs?.map((job) => job.id),
      ['provides', 'jobs'],
      'id'
    );
    addDuplicateIssues(
      ctx,
      settings?.map((setting) => setting.key),
      ['provides', 'settings'],
      'key'
    );

    const declared = new Set(permissions?.map((permission) => permission.key));

    panels?.forEach((panel, index) => {
      if (
        panel.permission !== undefined &&
        !declared.has(panel.permission) &&
        !corePermissionNames.has(panel.permission)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['provides', 'panels', index, 'permission'],
          message: `"${panel.permission}" is neither a declared permission nor a core Permission`,
        });
      }
    });
  });

export type ExtensionManifest = z.infer<typeof manifestSchema>;
export type ExtensionManifestRequires = z.infer<typeof requiresSchema>;
export type ExtensionManifestPermission = z.infer<typeof permissionSchema>;
export type ExtensionManifestNotification = z.infer<typeof notificationSchema>;
export type ExtensionManifestPanel = z.infer<typeof panelSchema>;
export type ExtensionManifestJob = z.infer<typeof jobSchema>;
export type ExtensionManifestSetting = z.infer<typeof settingSchema>;
export type ExtensionManifestSettingOption = z.infer<
  typeof settingOptionSchema
>;

/** Thrown by {@link parseManifest} when `seerr-extension.json` is invalid. */
export class ManifestValidationError extends Error {
  public readonly issues: z.core.$ZodIssue[];

  constructor(error: z.ZodError) {
    super(`Invalid extension manifest:\n${z.prettifyError(error)}`);
    this.name = 'ManifestValidationError';
    this.issues = error.issues;
  }
}

/**
 * Validates the parsed contents of a `seerr-extension.json`.
 *
 * @throws {ManifestValidationError} listing every problem found, so an operator
 * fixes the whole manifest in one pass rather than one field per boot.
 */
export function parseManifest(raw: unknown): ExtensionManifest {
  const result = manifestSchema.safeParse(raw);

  if (!result.success) {
    throw new ManifestValidationError(result.error);
  }

  return result.data;
}
