/**
 * The server-side SDK surface handed to an extension's entry point.
 *
 * Types only — the object is built by the loader (slice 3). This file is the
 * contract the published `@seerr/extension-sdk` package re-exports, so it
 * deliberately imports nothing from Seerr at runtime.
 *
 * Note the trust model: these declarations are capability hygiene, not a
 * security boundary. An extension is `require()`d into the Seerr process and
 * can bypass the SDK entirely with a raw `require('@server/datasource')`.
 */
import type { MediaType } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import type { Permission } from '@server/lib/permissions';
import type { MainSettings, TautulliSettings } from '@server/lib/settings';
import type { Request, Response } from 'express';
import type { DataSource, EntityTarget, Repository } from 'typeorm';
import type { Logger } from 'winston';
import type { ZodType, z } from 'zod';

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
  get(id: number): Promise<User | null>;
  /**
   * Whether a user holds a permission. Accepts an extension permission key
   * (namespaced to this extension) or a core `Permission`. Core
   * `Permission.ADMIN` grants every extension permission, matching
   * `hasPermission`'s existing short-circuit.
   */
  hasPermission(
    userId: number,
    permission: ExtensionPermissionKey | Permission
  ): Promise<boolean>;
}

/**
 * Enough of a title to render it: what a UI needs, and nothing else.
 *
 * Deliberately not core's `MovieDetails`/`TvDetails`. Those are large, they differ
 * between the two media types (`title`/`releaseDate` versus `name`/`firstAirDate`),
 * and they are shaped by what core's own pages happen to want — so handing them to
 * an extension would make every field core adds or renames a breaking change for
 * every extension. This is the flattened intersection, with one name per concept.
 */
export interface ExtensionMediaDetails {
  tmdbId: number;
  mediaType: MediaType;
  /** `title` for a movie, `name` for a series. */
  title: string;
  /** Release or first-air year, `null` when TMDB has no date. */
  year: number | null;
  /** Never undefined; an empty string when TMDB has no synopsis. */
  overview: string;
  /**
   * A URL a browser can use directly, already honouring the operator's
   * `cacheImages` setting — `/imageproxy/tmdb/…` when it is on, the tmdb.org URL
   * when it is off. `null` when the title has no artwork.
   *
   * Resolved here rather than in a UI because the *extension* is the backend: its
   * panel should be handed a `src`, not the TMDB path conventions, the size
   * strings, and a copy of the proxy rule. It also means an extension with no UI
   * at all — one that emails a digest, say — gets the same working URLs.
   */
  posterUrl: string | null;
  backdropUrl: string | null;
}

/**
 * What `requires: { media: 'read' }` grants. Lookups only.
 */
export interface ExtensionMedia {
  get(id: number): Promise<Media | null>;
  findByTmdbId(tmdbId: number, mediaType: MediaType): Promise<Media | null>;
  /**
   * The media a Plex rating key belongs to, matching either variant's key.
   *
   * For extensions joining an external watch-history source back to core.
   * Tautulli reports plays by `rating_key` and knows nothing of tmdbIds, so
   * without this an extension would have to reach into core's `media` table
   * itself to attribute a play to a title.
   *
   * Checks `ratingKey` and `ratingKey4k`, because they are two keys on one row
   * and a play of either is a play of this media. An empty or unknown key
   * resolves `null` — notably it does **not** match the many rows whose keys are
   * both null, which a naive two-clause `where` would.
   */
  findByRatingKey(ratingKey: string): Promise<Media | null>;
  /**
   * Displayable metadata for a core `Media` row: title, year, overview and image
   * URLs.
   *
   * The counterpart to `get`, which returns core's row — ids and statuses, the
   * things an extension reasons about, and nothing a person would recognize. An
   * extension that lists media therefore had no way to name it, which pushed the
   * problem into its panel and out of the extension's own backend where it
   * belongs.
   *
   * Keyed on the core media id rather than a tmdbId, matching `get` and
   * `remove`, so an extension that stores an id (as it should — that is the
   * durable key) needs nothing else to render it.
   *
   * Resolves `null` for a media row that does not exist, and **also** when TMDB
   * cannot be reached or does not know the title: a lookup failure must not take
   * out the extension route that was merely decorating a response. Callers should
   * treat it as "no metadata", not as "no media".
   */
  getDetails(id: number): Promise<ExtensionMediaDetails | null>;
}

/**
 * What `requires: { media: 'write' }` grants: the read surface plus the
 * destructive members.
 *
 * `extends ExtensionMedia` rather than a separate, disjoint interface, because
 * write access is *additive* — an extension that removes media invariably reads
 * it first, and forcing it to declare both would make `requires.media` a
 * two-valued field with three meaningful states. It also means the runtime gate
 * can build the read object and attach to it, so there is one implementation of
 * `get`, and `ExtensionMedia` stays the type every existing extension and every
 * read-only consumer refers to.
 *
 * Note the asymmetry with the rest of the SDK: core keeps and owns the
 * destructive code. `remove` is a request for core to perform its own removal,
 * not a repository an extension drives. That is what makes it reviewable — the
 * Radarr/Sonarr resolution, the season fan-out and the status bookkeeping live in
 * `@server/lib/mediaRemoval` and are shared with `DELETE /api/v1/media/:id/file`.
 */
export interface ExtensionMediaWrite extends ExtensionMedia {
  /**
   * Removes the media from the Radarr/Sonarr server it was added to, marks it
   * (and, for a series, every season) `MediaStatus.DELETED`, and saves the row.
   *
   * Unlike core's `removeMediaFromServarr`, this *does* persist: an extension has
   * no repository for core's `Media`, so a member that only mutated would leave
   * it holding an unsaveable object.
   *
   * Rejects if the media does not exist, and lets core's `NoServarrServerError`
   * propagate unwrapped — an extension needs to tell "the operator has no Radarr
   * configured" from "the Radarr call failed", and the two call for different
   * responses. Import it from `@server/lib/mediaRemoval` to `instanceof` it, or
   * match on the error's `arrName` property.
   *
   * @param mediaId Core `Media` row id, as returned by `get`/`findByTmdbId`.
   * @param is4k Whether to remove the 4K variant. Defaults to false.
   */
  remove(mediaId: number, is4k?: boolean): Promise<void>;
}

/**
 * A media type `sdk.discover` can be asked about.
 *
 * Narrower than TMDB's `media_type`, which also carries `person` and
 * `collection`: those are not things an extension can recommend a *title* from,
 * and every member of this surface is keyed on a tmdbId plus one of these two.
 */
export type ExtensionDiscoverMediaType = 'movie' | 'tv';

/**
 * What `requires: { discover: 'read' }` grants: TMDB lookups that are not tied
 * to a row in core's `media` table.
 *
 * The counterpart to `sdk.media`, which answers "what does core know about this
 * media id". This answers "what else is there" — and it exists so an extension
 * does not ship its own TMDB key. Core's client is cached (`cacheManager`'s
 * `tmdb` cache) and rate-limited (20 requests / 50 RPS); a second key inside an
 * extension would share neither, so the operator's TMDB budget would be spent
 * twice and the limiter would stop protecting them.
 *
 * Every member resolves {@link ExtensionMediaDetails}, the same shape
 * `sdk.media.getDetails` returns, with poster and backdrop URLs already
 * resolved against the operator's `cacheImages` setting. An extension is a
 * backend: its panel receives a `src`, not TMDB path conventions.
 *
 * Failures resolve to an **empty array** rather than rejecting, for the reason
 * `getDetails` resolves `null`: a caller is decorating a response it could
 * serve without this, so a TMDB outage must not turn into a broken extension
 * route. "Nothing to suggest" and "could not ask" are the same thing to a
 * renderer.
 */
export interface ExtensionDiscover {
  /**
   * What is trending on TMDB right now, movies and series interleaved as TMDB
   * ranks them. `person` and `collection` results are dropped.
   */
  trending(options?: {
    /** TMDB's own window. Defaults to `'week'`, the steadier of the two. */
    timeWindow?: 'day' | 'week';
    page?: number;
  }): Promise<ExtensionMediaDetails[]>;
  /**
   * TMDB's recommendations for a title: "people who liked this liked these".
   * Editorially stronger than {@link similar} and the better default.
   */
  recommendations(
    tmdbId: number,
    mediaType: ExtensionDiscoverMediaType,
    options?: { page?: number }
  ): Promise<ExtensionMediaDetails[]>;
  /**
   * TMDB's similar titles: keyword and genre overlap, with no popularity
   * signal. Broader and noisier than {@link recommendations}, and the fallback
   * when a title is too obscure to have any.
   */
  similar(
    tmdbId: number,
    mediaType: ExtensionDiscoverMediaType,
    options?: { page?: number }
  ): Promise<ExtensionMediaDetails[]>;
}

export interface ExtensionRequestsQuery {
  userId?: number;
  mediaId?: number;
  take?: number;
  skip?: number;
}

export interface ExtensionRequests {
  list(query?: ExtensionRequestsQuery): Promise<MediaRequest[]>;
  get(id: number): Promise<MediaRequest | null>;
}

/**
 * A value an operator may have saved for a declared setting. Mirrors
 * `ExtensionSettingValue` in `@server/lib/settings`, restated here so this
 * contract keeps importing nothing from Seerr at runtime.
 */
export type ExtensionSettingValue = boolean | string | number;

export interface ExtensionSettings {
  /**
   * Core's main settings: read-only, with secrets (`apiKey`) redacted.
   *
   * Optional because `sdk.settings` is now attached for two independent reasons —
   * `requires.settings: 'read'`, which is what asks for *core's* settings, and
   * `provides.settings`, which is the extension's own. An extension that declares
   * settings without requiring core's gets `own` and no `main`, so the manifest
   * stays an honest description of what it reads.
   */
  main?: Readonly<MainSettings>;
  /**
   * This extension's own settings, as the operator has them, keyed by the
   * manifest-local key from `provides.settings`, with declared defaults applied.
   *
   * A key with no saved value and no declared default is **absent**, so
   * `'endpoint' in sdk.settings.own` tells "not configured" from "saved empty".
   *
   * Secrets are here **unredacted**. Redaction protects secrets from the browser,
   * not from the extension: extension code runs in the Seerr process and needs the
   * real credential to use it. A read reflects the current state rather than a
   * snapshot taken at activation, so a change the operator makes while Seerr is
   * running is visible on the next read.
   */
  /**
   * Core's Tautulli connection, when the operator has configured one and the
   * manifest declared `requires.settings`. `undefined` when Tautulli is not
   * configured.
   *
   * Here rather than as a setting each extension declares for itself, for the
   * reason `sdk.discover` wraps core's TMDB client: core already knows where
   * Tautulli is, and making the operator enter the same hostname a second time
   * means two copies that drift the moment one is changed.
   *
   * **`apiKey` is absent**, not empty — redacted like `main.apiKey`, and by
   * omission so `'apiKey' in tautulli` is a feature test. An extension therefore
   * cannot call Tautulli with the operator's key from here; what it gets is
   * enough to know whether Tautulli exists and to show the operator which server
   * it is reading.
   */
  tautulli?: Readonly<Omit<TautulliSettings, 'apiKey'>>;
  own: Readonly<Record<string, ExtensionSettingValue>>;
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
  notifyUser?: User;
  media?: Media;
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
 *
 * The spec enumerates `'media.available' | 'request.approved' | ...`; this is
 * that list resolved against what the subscribers actually detect.
 */
export interface ExtensionEventMap {
  'media.available': { media: Media; is4k: boolean };
  'media.partially-available': { media: Media; is4k: boolean };
  'request.created': { request: MediaRequest };
  'request.approved': { request: MediaRequest };
  'request.declined': { request: MediaRequest };
  'request.available': { request: MediaRequest };
  'request.failed': { request: MediaRequest };
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
 * into a runtime `TypeError` instead of a compile error. `defineExtension` is
 * the place to narrow them once a manifest is in scope.
 */
export interface ExtensionSdk {
  id: string;
  /** Child of `server/logger`, labelled `Extension:<id>`. */
  logger: Logger;
  /** Present when `requires.store` is declared. */
  store?: ExtensionStore;
  /** Present when `requires.users` is declared. */
  users?: ExtensionUsers;
  /**
   * Present when `requires.media` is declared; `remove` only when it is
   * `'write'`.
   *
   * Typed as the *write* interface even though a read-only extension is handed
   * an object without `remove`, for the same reason every gated member here is
   * optional rather than narrowed: this is the host contract, which has no
   * manifest in scope to narrow against. `defineExtension` in
   * `@seerr/extension-sdk` is where `'read'` resolves to {@link ExtensionMedia}
   * and `'write'` to {@link ExtensionMediaWrite}, so an author who calls
   * `remove` without declaring write access gets a compile error there.
   */
  media?: ExtensionMediaWrite;
  /** Present when `requires.requests` is declared. */
  requests?: ExtensionRequests;
  /** Present when `requires.discover` is declared. */
  discover?: ExtensionDiscover;
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
