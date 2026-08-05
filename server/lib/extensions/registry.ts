import type {
  ExtensionManifest,
  ExtensionManifestJob,
} from '@server/lib/extensions/manifest';
import type {
  ExtensionEvent,
  ExtensionEventMap,
  ExtensionRouteHandler,
  ExtensionRouteOptions,
  ExtensionSetup,
} from '@server/lib/extensions/types';
import logger from '@server/logger';
import path from 'path';
import type { EntitySchema } from 'typeorm';

/**
 * Where an extension got to.
 *
 * - `pending` — discovered and validated, not yet activated.
 * - `active` — its entry point ran without throwing.
 * - `failed` — quarantined. Never fatal: Seerr boots regardless.
 * - `disabled` — present on disk but switched off by the operator.
 */
export type ExtensionStatus = 'pending' | 'active' | 'failed' | 'disabled';

/**
 * What the admin UI (slice 8) reads. `name` and `version` are absent when the
 * manifest itself is what failed, since there is nothing trustworthy to report.
 */
export interface ExtensionHealth {
  id: string;
  name?: string;
  version?: string;
  status: ExtensionStatus;
  error?: string;
}

export type ExtensionRouteMethod = 'get' | 'post' | 'put' | 'delete';

/** A route an extension declared, for slice 5 to mount. */
export interface ExtensionRoute {
  extensionId: string;
  method: ExtensionRouteMethod;
  /** Relative to `/api/v1/ext/<extensionId>`. */
  path: string;
  options: ExtensionRouteOptions;
  handler: ExtensionRouteHandler;
}

/** A job an extension declared in its manifest and registered a body for. */
export interface ExtensionJob {
  extensionId: string;
  /** The manifest-local job id; not namespaced. */
  id: string;
  name: string;
  schedule: string;
  run: () => Promise<void>;
}

/** A panel an extension's manifest provides, for slice 6 to serve. */
export interface ExtensionPanel {
  extensionId: string;
  slug: string;
  title: string;
  /** Absolute path to the pre-built ESM bundle. */
  entryPath: string;
  /**
   * The extension's own directory, which `entryPath` must stay inside. Carried
   * here so the route serving the bundle can re-check containment without
   * looking the entry back up in the registry.
   */
  directory: string;
  sidebar?: { icon: string; order?: number };
  permission?: string;
}

/** An entity class or `EntitySchema` an extension contributes. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export type ExtensionEntity = Function | EntitySchema;

export interface ExtensionEntry {
  /**
   * The directory name, which discovery requires to equal the manifest `id`. It
   * is the id even when the manifest failed to parse, so a broken extension is
   * still identifiable in the admin UI.
   */
  id: string;
  directory: string;
  manifest?: ExtensionManifest;
  status: ExtensionStatus;
  error?: string;
  entities: ExtensionEntity[];
  migrations: (new () => unknown)[];
  setup?: ExtensionSetup;
}

interface ExtensionListener {
  extensionId: string;
  fn: (payload: never) => void | Promise<void>;
}

/**
 * Everything one extension registered during its own activation, held aside
 * until that activation returns.
 *
 * Staged rather than written straight into the registry so an extension that
 * registers three routes and then throws contributes nothing at all — a
 * half-registered extension is worse than an absent one, because slice 5 would
 * mount routes whose setup never finished.
 */
export class ExtensionRegistrations {
  public readonly routes: ExtensionRoute[] = [];
  public readonly jobs: ExtensionJob[] = [];
  public readonly listeners: {
    event: ExtensionEvent;
    listener: ExtensionListener;
  }[] = [];
}

/**
 * The set of installed extensions and what they contribute.
 *
 * Built in two phases, because TypeORM cannot register entities after
 * `initialize()`: discovery fills in manifests and entity classes with no
 * database access, then activation runs entry points and records their
 * registrations. See docs/specs/extension-system.md, "Storage: namespaced
 * tables in the main database".
 */
export class ExtensionRegistry {
  private entries = new Map<string, ExtensionEntry>();
  private routeList: ExtensionRoute[] = [];
  private jobList: ExtensionJob[] = [];
  private panelList: ExtensionPanel[] = [];
  private listeners = new Map<ExtensionEvent, ExtensionListener[]>();

  /**
   * Entity classes to inject into the main DataSource before `initialize()`.
   * Excludes anything quarantined or disabled, so a broken extension does not
   * contribute a table.
   */
  public get entities(): ExtensionEntity[] {
    return this.all()
      .filter(
        (entry) => entry.status === 'pending' || entry.status === 'active'
      )
      .flatMap((entry) => entry.entities);
  }

  /** Every entry, ordered by id. */
  public all(): ExtensionEntry[] {
    return [...this.entries.values()];
  }

  public get(id: string): ExtensionEntry | undefined {
    return this.entries.get(id);
  }

  public active(): ExtensionEntry[] {
    return this.all().filter((entry) => entry.status === 'active');
  }

  public health(): ExtensionHealth[] {
    return this.all().map((entry) => ({
      id: entry.id,
      ...(entry.manifest
        ? { name: entry.manifest.name, version: entry.manifest.version }
        : {}),
      status: entry.status,
      ...(entry.error ? { error: entry.error } : {}),
    }));
  }

  public routes(): ExtensionRoute[] {
    return [...this.routeList];
  }

  public routesFor(extensionId: string): ExtensionRoute[] {
    return this.routeList.filter((route) => route.extensionId === extensionId);
  }

  public jobs(): ExtensionJob[] {
    return [...this.jobList];
  }

  public panels(): ExtensionPanel[] {
    return [...this.panelList];
  }

  public panelsFor(extensionId: string): ExtensionPanel[] {
    return this.panelList.filter((panel) => panel.extensionId === extensionId);
  }

  /**
   * Re-emits a core transition to the extensions listening for it.
   *
   * A listener that throws is logged and skipped: extension code must not be
   * able to fail the subscriber that emitted the event, which is running inside
   * core's own write path.
   */
  public async emit<TEvent extends ExtensionEvent>(
    event: TEvent,
    payload: ExtensionEventMap[TEvent]
  ): Promise<void> {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        await listener.fn(payload as never);
      } catch (e) {
        logger.error('Extension event listener failed', {
          label: 'Extensions',
          extensionId: listener.extensionId,
          event,
          errorMessage: e.message,
        });
      }
    }
  }

  // #region mutation, used by the loader

  /** Inserts an entry, keeping {@link all} ordered by id. */
  public add(entry: ExtensionEntry): void {
    this.entries.set(entry.id, entry);
    this.entries = new Map(
      [...this.entries].sort(([a], [b]) => a.localeCompare(b))
    );
  }

  /**
   * Quarantines an extension. Logged here rather than at each call site so that
   * every path into `failed` — unreadable directory, invalid manifest,
   * apiVersion mismatch, entity load, `require`, entry point, migration —
   * produces the same operator-visible record.
   */
  public fail(id: string, error: unknown, context: string): void {
    const message = error instanceof Error ? error.message : String(error);
    const entry = this.entries.get(id);

    if (entry) {
      entry.status = 'failed';
      entry.error = message;
    }

    logger.error(`Extension "${id}" quarantined while ${context}`, {
      label: 'Extensions',
      extensionId: id,
      errorMessage: message,
    });
  }

  /** Promotes a successfully activated extension and publishes what it declared. */
  public commit(
    entry: ExtensionEntry,
    registrations: ExtensionRegistrations
  ): void {
    entry.status = 'active';
    delete entry.error;

    this.routeList.push(...registrations.routes);
    this.jobList.push(...registrations.jobs);
    this.panelList.push(...panelsOf(entry));

    for (const { event, listener } of registrations.listeners) {
      const existing = this.listeners.get(event);

      if (existing) {
        existing.push(listener);
      } else {
        this.listeners.set(event, [listener]);
      }
    }
  }

  // #endregion
}

function panelsOf(entry: ExtensionEntry): ExtensionPanel[] {
  return (entry.manifest?.provides?.panels ?? []).map((panel) => ({
    extensionId: entry.id,
    slug: panel.slug,
    title: panel.title,
    entryPath: path.join(entry.directory, panel.entry),
    directory: entry.directory,
    ...(panel.sidebar ? { sidebar: panel.sidebar } : {}),
    ...(panel.permission ? { permission: panel.permission } : {}),
  }));
}

/** The manifest-declared job with this id, or `undefined` if undeclared. */
export function declaredJob(
  manifest: ExtensionManifest | undefined,
  id: string
): ExtensionManifestJob | undefined {
  return manifest?.provides?.jobs?.find((job) => job.id === id);
}
