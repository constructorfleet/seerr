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
 * What the admin UI reads. `name` and `version` are absent when the
 * manifest itself is what failed, since there is nothing trustworthy to report.
 */
export interface ExtensionHealth {
  id: string;
  name?: string;
  version?: string;
  status: ExtensionStatus;
  error?: string;
  /**
   * A `PanelIconName` for the admin UI to draw beside this extension.
   *
   * Not a manifest field of its own: it is the icon the extension already
   * declared for its sidebar link, reported here so the settings pages stop
   * drawing a hardcoded puzzle piece for an extension the sidebar draws a
   * trashcan for. Absent when no panel declares one, which is the only case where
   * a puzzle piece is the truth.
   */
  icon?: string;
}

/**
 * The icon an entry's manifest declares, for {@link ExtensionHealth}.
 *
 * Read off the *manifest* rather than the registered panel list, because health is
 * reported for `pending` and `failed` entries too — neither has run its entry
 * point, so neither has registered a panel, but both have a manifest to read.
 *
 * Lowest `order` wins, and an undeclared `order` sorts last, matching how the
 * sidebar orders the same links: an extension with several panels then shows the
 * icon of the one listed first there, instead of whichever happened to come first
 * in the manifest array.
 */
function manifestIcon(entry: ExtensionEntry): string | undefined {
  const withIcons = (entry.manifest?.provides?.panels ?? []).filter(
    (panel) => panel.sidebar?.icon
  );

  if (!withIcons.length) {
    return undefined;
  }

  return withIcons.reduce((best, panel) =>
    (panel.sidebar?.order ?? Number.MAX_SAFE_INTEGER) <
    (best.sidebar?.order ?? Number.MAX_SAFE_INTEGER)
      ? panel
      : best
  ).sidebar?.icon;
}

export type ExtensionRouteMethod = 'get' | 'post' | 'put' | 'delete';

/** A route an extension declared, for `createExtensionRouter` to mount. */
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

/** A panel an extension's manifest provides, for the panel route to serve. */
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
  /**
   * What {@link ExtensionRegistry.deactivate} has to run. Held on the entry
   * rather than in {@link ExtensionRegistrations}, which is discarded once
   * committed, because deactivation happens arbitrarily later.
   */
  disposers?: ExtensionDisposer[];
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
 * half-registered extension is worse than an absent one: the router would mount
 * routes whose setup never finished.
 */
export class ExtensionRegistrations {
  public readonly routes: ExtensionRoute[] = [];
  public readonly jobs: ExtensionJob[] = [];
  public readonly listeners: {
    event: ExtensionEvent;
    listener: ExtensionListener;
  }[] = [];
  /**
   * Teardown callbacks the extension asked for with `sdk.onDispose`, run when it
   * is deactivated. Staged with the rest, so an extension that registers a
   * disposer and *then* throws never has it called — there is nothing to tear
   * down, since its registrations were discarded too.
   */
  public readonly disposers: ExtensionDisposer[] = [];
}

/** A teardown callback registered through `sdk.onDispose`. */
export type ExtensionDisposer = () => void | Promise<void>;

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
    return this.all().map((entry) => {
      const icon = manifestIcon(entry);

      return {
        id: entry.id,
        ...(entry.manifest
          ? { name: entry.manifest.name, version: entry.manifest.version }
          : {}),
        status: entry.status,
        ...(entry.error ? { error: entry.error } : {}),
        ...(icon ? { icon } : {}),
      };
    });
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
    entry.disposers = [...registrations.disposers];

    for (const { event, listener } of registrations.listeners) {
      const existing = this.listeners.get(event);

      if (existing) {
        existing.push(listener);
      } else {
        this.listeners.set(event, [listener]);
      }
    }
  }

  /**
   * The inverse of {@link commit}: drops everything an extension contributed and
   * marks it `disabled`.
   *
   * This is what "disable" means in the running process. It cannot be a full
   * unload — the extension's module stays in `require.cache` and its entities
   * stay in the initialized DataSource (Constraint 4), so *re-enabling* still
   * needs a restart — but it does mean a disabled extension stops answering
   * requests, stops running jobs and stops seeing events without one.
   *
   * Returns the disposers the caller has to run. They are not run here because
   * this method is synchronous by design: it is the state change, and it must not
   * be able to half-apply because extension teardown code awaited something and
   * threw. `server/lib/extensions/lifecycle.ts` sequences the two.
   */
  public deactivate(id: string): ExtensionDisposer[] {
    const entry = this.entries.get(id);

    if (!entry || entry.status !== 'active') {
      return [];
    }

    const disposers = entry.disposers ?? [];

    entry.status = 'disabled';
    delete entry.disposers;

    this.routeList = this.routeList.filter((route) => route.extensionId !== id);
    this.jobList = this.jobList.filter((job) => job.extensionId !== id);
    this.panelList = this.panelList.filter((panel) => panel.extensionId !== id);

    for (const [event, listeners] of this.listeners) {
      const remaining = listeners.filter(
        (listener) => listener.extensionId !== id
      );

      // Deleted rather than left as an empty array, so `emit` does not walk a
      // growing map of events nothing listens to after a few disable cycles.
      if (remaining.length) {
        this.listeners.set(event, remaining);
      } else {
        this.listeners.delete(event);
      }
    }

    return disposers;
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
