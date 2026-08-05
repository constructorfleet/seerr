import { reservedExtensionId } from '@server/lib/extensions/coreTables';
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
 * A name exported by `@heroicons/react/24/outline`. Only the shape is checked
 * here; the name is resolved against an explicit allowlist map when a sidebar
 * entry is rendered, never by dynamic import of an arbitrary string.
 */
const heroicon = z
  .string()
  .regex(/^[A-Z][A-Za-z0-9]*Icon$/, 'must be a heroicons outline icon name');

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
  store: z.boolean().optional(),
  jobs: z.boolean().optional(),
  /** Outbound allowlist. Advisory in v1 — documented, unenforced. */
  http: z.array(hostname).optional(),
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

const providesSchema = z.strictObject({
  permissions: z.array(permissionSchema).optional(),
  notifications: z.array(notificationSchema).optional(),
  panels: z.array(panelSchema).optional(),
  jobs: z.array(jobSchema).optional(),
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
    const { permissions, notifications, panels, jobs } =
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
