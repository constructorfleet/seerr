/**
 * The server-side SDK surface handed to an extension's entry point.
 *
 * The published mirror of `server/lib/extensions/types.ts`, which is the
 * contract. Structurally identical, with the Seerr entity `type`-imports
 * replaced by the re-declarations in `./entities` — see that file's header for
 * why, and `conformance/hostContract.ts` for the typecheck that keeps the two in
 * step.
 *
 * Note the trust model: these declarations are capability hygiene, not a
 * security boundary. An extension is `require()`d into the Seerr process and can
 * bypass the SDK entirely with a raw `require('@server/datasource')`.
 */
import type { Request, Response } from 'express';
import type { DataSource, EntityTarget, Repository } from 'typeorm';
import type { Logger } from 'winston';
import type { ZodType, z } from 'zod';
import type {
  SeerrMainSettings,
  SeerrMedia,
  SeerrMediaRequest,
  SeerrMediaType,
  SeerrPermissionValue,
  SeerrUser,
} from './entities';

/** Access level an extension may declare for a core capability. */
export type ExtensionAccessLevel = 'read' | 'write';

/**
 * A permission an extension route or panel may be gated on: one of the
 * extension's own manifest permission keys, or a core `Permission` member.
 *
 * Kept a plain `string` rather than a union with `Permission` (a number),
 * because the two spaces are resolved by different code paths and a numeric
 * value here would be indistinguishable from a bitmask.
 */
export type ExtensionPermissionKey = string;

// #region store

/** Small per-extension key/value state, for cursors and last-run timestamps. */
export interface ExtensionKvStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys belonging to this extension, optionally filtered by prefix. */
  list(prefix?: string): Promise<string[]>;
}

/**
 * Persistent storage. Entities are registered into the **main** DataSource with
 * table names prefixed `ext_<id>_`; extension migrations are tracked in
 * `ext_<id>_migration`, never core's `migrations` table.
 */
export interface ExtensionStore {
  dataSource: DataSource;
  getRepository<Entity extends object>(
    target: EntityTarget<Entity>
  ): Repository<Entity>;
  kv: ExtensionKvStore;
}

// #endregion

// #region core data access

export interface ExtensionUsers {
  get(id: number): Promise<SeerrUser | null>;
  /**
   * Whether a user holds a permission. Accepts an extension permission key
   * (namespaced to this extension) or a core `Permission`. Core
   * `Permission.ADMIN` grants every extension permission, matching
   * `hasPermission`'s existing short-circuit.
   */
  hasPermission(
    userId: number,
    permission: ExtensionPermissionKey | SeerrPermissionValue
  ): Promise<boolean>;
}

export interface ExtensionMedia {
  get(id: number): Promise<SeerrMedia | null>;
  findByTmdbId(
    tmdbId: number,
    mediaType: SeerrMediaType
  ): Promise<SeerrMedia | null>;
}

export interface ExtensionRequestsQuery {
  userId?: number;
  mediaId?: number;
  take?: number;
  skip?: number;
}

export interface ExtensionRequests {
  list(query?: ExtensionRequestsQuery): Promise<SeerrMediaRequest[]>;
  get(id: number): Promise<SeerrMediaRequest | null>;
}

export interface ExtensionSettings {
  /** Read-only, with secrets (`apiKey`) redacted. */
  main: Readonly<SeerrMainSettings>;
}

// #endregion

// #region notifications

/**
 * Payload for `sdk.notify.send`. A subset of core's `NotificationPayload`: the
 * host fills in `event`, the notification type sentinel, and the
 * `extensionEvent` descriptor that agents fall back to for display.
 */
export interface ExtensionNotificationPayload {
  subject: string;
  message?: string;
  image?: string;
  extra?: { name: string; value: string }[];
  /** The user to notify. Omit to notify admins only. */
  notifyUser?: SeerrUser;
  media?: SeerrMedia;
}

export interface ExtensionNotify {
  /**
   * @param key A notification key declared in this extension's manifest,
   * namespaced to `<extensionId>:<key>` before delivery.
   */
  send(key: string, payload: ExtensionNotificationPayload): Promise<void>;
}

// #endregion

// #region routes

/**
 * The body a handler receives: the output of the route's zod schema when one is
 * declared, `unknown` otherwise.
 *
 * Extension routes are mounted **before** the OpenAPI validator (it rejects
 * undocumented paths, and extension paths cannot be in `seerr-api.yml`), so
 * they get no request validation for free. The schema is the compensation.
 */
export type ExtensionRequestBody<TSchema> =
  TSchema extends ZodType<unknown> ? z.output<TSchema> : unknown;

export interface ExtensionRouteRequest<TBody = unknown> extends Request {
  body: TBody;
  /**
   * The authenticated user, populated by the extension router's `checkUser`.
   * Present for a route with a `permission`, since the permission check rejects an
   * unauthenticated request before the handler runs.
   *
   * Declared here rather than inherited. In the Seerr repository this comes from a
   * global `Express.Request` augmentation in `server/types/express.d.ts`, which is
   * ambient host source and not something a published package can — or should —
   * ship: a `declare global` in a `.d.ts` would silently add `user` to every
   * Express `Request` in the consuming project. Redeclaring it on this interface
   * is the same information, scoped to the routes it actually applies to.
   */
  user?: SeerrUser;
}

export type ExtensionRouteHandler<TBody = unknown> = (
  req: ExtensionRouteRequest<TBody>,
  res: Response
) => void | Promise<void>;

export interface ExtensionRouteOptions<TSchema extends ZodType = ZodType> {
  /** An extension permission key or a core `Permission` member name. */
  permission?: ExtensionPermissionKey;
  /** Validated before the handler runs; a failure is a 400. */
  body?: TSchema;
}

export type ExtensionRouteRegistrar = <TSchema extends ZodType = ZodType>(
  path: string,
  options: ExtensionRouteOptions<TSchema>,
  handler: ExtensionRouteHandler<ExtensionRequestBody<TSchema>>
) => void;

/** Mounted at `/api/v1/ext/<id>`. */
export interface ExtensionRouter {
  get: ExtensionRouteRegistrar;
  post: ExtensionRouteRegistrar;
  put: ExtensionRouteRegistrar;
  delete: ExtensionRouteRegistrar;
}

// #endregion

// #region jobs

export interface ExtensionJobs {
  /**
   * @param id A job id declared in this extension's manifest; its `schedule`
   * comes from there.
   */
  register(id: string, fn: () => Promise<void>): void;
}

// #endregion

// #region events

/**
 * Transitions an extension can observe, backed by core's TypeORM subscribers
 * (`server/subscriber/*`) re-emitting onto an internal bus, so extensions see
 * the same transitions core does.
 */
export interface ExtensionEventMap {
  'media.available': { media: SeerrMedia; is4k: boolean };
  'media.partially-available': { media: SeerrMedia; is4k: boolean };
  'request.created': { request: SeerrMediaRequest };
  'request.approved': { request: SeerrMediaRequest };
  'request.declined': { request: SeerrMediaRequest };
  'request.available': { request: SeerrMediaRequest };
  'request.failed': { request: SeerrMediaRequest };
}

export type ExtensionEvent = keyof ExtensionEventMap;

export interface ExtensionEvents {
  on<TEvent extends ExtensionEvent>(
    event: TEvent,
    fn: (payload: ExtensionEventMap[TEvent]) => void | Promise<void>
  ): void;
}

// #endregion

/**
 * The object an extension's entry point receives.
 *
 * The capability-gated members are optional because that is what the loader
 * actually hands over: an extension gets only what its manifest `requires`
 * asked for. Typing them as always-present would turn a missing declaration
 * into a runtime `TypeError` instead of a compile error.
 *
 * {@link defineExtension} narrows them back to non-optional from a literal
 * manifest — see `./defineExtension`.
 */
export interface ExtensionSdk {
  id: string;
  /** Child of `server/logger`, labelled `Extension:<id>`. */
  logger: Logger;
  /** Present when `requires.store` is declared. */
  store?: ExtensionStore;
  /** Present when `requires.users` is declared. */
  users?: ExtensionUsers;
  /** Present when `requires.media` is declared. */
  media?: ExtensionMedia;
  /** Present when `requires.requests` is declared. */
  requests?: ExtensionRequests;
  /** Present when `requires.settings` is declared. */
  settings?: ExtensionSettings;
  /** Present when the manifest provides at least one notification type. */
  notify?: ExtensionNotify;
  router: ExtensionRouter;
  /** Present when `requires.jobs` is declared. */
  jobs?: ExtensionJobs;
  events: ExtensionEvents;
}

/**
 * An extension's server entry point: the default export of the file named by
 * the manifest's `server` field.
 */
export type ExtensionSetup = (sdk: ExtensionSdk) => void | Promise<void>;
