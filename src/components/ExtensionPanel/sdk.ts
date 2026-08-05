/**
 * What a panel component receives as its single prop.
 *
 * A panel is loaded at runtime and cannot import from `@app/*` — it is not part
 * of this build — so everything it needs arrives here instead. Keeping it to one
 * prop object also means adding a capability later is not a breaking signature
 * change for already-published panels.
 */
import type { ExtensionPanelSummary } from '@app/hooks/useExtensionPanels';
import type { User } from '@app/hooks/useUser';
import type { AxiosInstance } from 'axios';
import axios from 'axios';
import type { IntlShape } from 'react-intl';

/** What `sdk.imageUrl` will rewrite. Mirrors `CachedImage`'s `type`. */
export type ExtensionImageKind = 'tmdb' | 'tvdb' | 'avatar';

export interface ExtensionPanelSdk {
  /** The signed-in user. */
  user: User;
  /**
   * Whether the user holds a permission. Accepts an extension permission key
   * (bare, namespaced against the panel's own extension) or a core `Permission`
   * name — resolved against what the server already reported, so it is
   * synchronous.
   */
  hasPermission: (permission: string | string[]) => boolean;
  /** Pre-scoped to `/api/v1/ext/<extensionId>/`, so a panel calls its own routes by relative path. */
  api: AxiosInstance;
  /**
   * Scoped to `/api/v1/`: core's own read API, as the signed-in user.
   *
   * A panel runs in the browser under the same session cookie as the rest of the
   * app, so it can already reach every endpoint the user can — `fetch('/api/v1/…')`
   * needs no permission this does not. Handing over a client makes that explicit
   * rather than folklore, and carries the CSRF headers, so a panel does not
   * hand-roll one and get non-GET requests rejected.
   *
   * What this is *for* is the metadata a server-side capability has no business
   * shipping: posters, titles, release years. The server SDK deliberately exposes
   * core `Media` rows — ids and statuses — and not TMDB details, because an
   * extension that needs a poster needs it in a browser, and routing TMDB through
   * a server capability would mean core proxying and caching on the extension's
   * behalf for a purely presentational read. The endpoints are the same ones
   * Seerr's own pages use (`GET movie/:tmdbId`, `GET tv/:tmdbId`, `GET user/:id`),
   * every one of them `isAuthenticated()` and no more.
   *
   * Two things this is *not*. It is not a way around an extension's manifest: the
   * ceiling is what the signed-in *user* may read, so a panel reading
   * `settings/main` gets the same 403 the user would. And core's routes are not
   * this project's stable API — a panel pinned to one is pinned to a Seerr
   * version, where `sdk.api` and the extension's own routes are the extension's
   * own contract. Reach for it for presentation, not for logic.
   */
  coreApi: AxiosInstance;
  /**
   * A displayable URL for a TMDB, TVDB or avatar image, honouring the operator's
   * `cacheImages` setting.
   *
   * Panels cannot use `CachedImage`: it is host source behind `@app/*`, and it is
   * a Next `<Image>`, which needs the host's build. So the one thing a panel would
   * otherwise get wrong — bypassing `/imageproxy/` when an operator has asked for
   * every image to be proxied — is done here instead, and the panel renders a
   * plain `<img>` with the result.
   */
  imageUrl: (src: string, kind: ExtensionImageKind) => string;
  /** A toast. */
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** The host's `IntlShape`, so a panel formats dates and numbers in the user's locale. */
  intl: IntlShape;
  panel: ExtensionPanelSummary;
}

/**
 * An axios instance scoped to the extension's own namespace.
 *
 * Built from the default instance rather than a bare `axios.create()` so it
 * inherits the app's CSRF behavior: axios reads the `XSRF-TOKEN` cookie the
 * server sets (`server/index.ts`) and sends the matching header, which
 * non-GET extension routes need.
 */
export function createPanelApi(extensionId: string): AxiosInstance {
  const instance = axios.create({
    baseURL: `/api/v1/ext/${extensionId}/`,
    xsrfCookieName: axios.defaults.xsrfCookieName,
    xsrfHeaderName: axios.defaults.xsrfHeaderName,
  });

  return instance;
}

/**
 * An axios instance scoped to core's API, for `sdk.coreApi`.
 *
 * Same CSRF inheritance as {@link createPanelApi}, and deliberately a *separate*
 * instance rather than the default one: a panel that got `axios` itself could
 * retarget interceptors and defaults the whole app shares.
 */
export function createCoreApi(): AxiosInstance {
  return axios.create({
    baseURL: '/api/v1/',
    xsrfCookieName: axios.defaults.xsrfCookieName,
    xsrfHeaderName: axios.defaults.xsrfHeaderName,
  });
}

/**
 * `CachedImage`'s URL rewriting, without the component.
 *
 * Extracted so `sdk.imageUrl` and `CachedImage` cannot disagree about when
 * `/imageproxy/` applies — the rule is small, but an operator who turned on
 * `cacheImages` to stop the browser talking to tmdb.org would be surprised to
 * find one panel doing it anyway.
 *
 * `src.startsWith('/')` is already-local, and an `avatar` is never a proxy
 * candidate: it may be a Jellyfin URL or a local path, neither of which the
 * imageproxy routes serve.
 */
export function resolveImageUrl(
  src: string,
  kind: ExtensionImageKind,
  cacheImages: boolean
): string {
  if (!cacheImages || src.startsWith('/')) {
    return src;
  }

  if (kind === 'tmdb') {
    return src.replace(/^https:\/\/image\.tmdb\.org\//, '/imageproxy/tmdb/');
  }

  if (kind === 'tvdb') {
    return src.replace(
      /^https:\/\/artworks\.thetvdb\.com\//,
      '/imageproxy/tvdb/'
    );
  }

  return src;
}
