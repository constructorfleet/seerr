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
   * An SWR fetcher over {@link api}, for `useSWR(key, sdk.fetcher)`.
   *
   * `swr` is a shared specifier, so a panel can import `useSWR` and get the
   * host's instance — but the host's *global* fetcher is configured for core's
   * `/api/v1` routes, not this extension's namespace. A panel calling
   * `useSWR('/removable')` therefore hit the wrong URL, and the examples worked
   * around it by avoiding SWR altogether and hand-rolling `useEffect` loaders.
   *
   * Passing this explicitly is the fix, and it must stay explicit: SWR resolves a
   * fetcher per hook call, and there is no way to rebind the shared instance's
   * default for one subtree without changing it for the host too.
   *
   * The key is the relative path, which doubles as the cache key — so two panels
   * of different extensions asking for `/items` do not collide, since each
   * fetcher resolves against its own `baseURL`.
   */
  fetcher: <T = unknown>(path: string) => Promise<T>;
  /** A toast. */
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** The host's `IntlShape`, so a panel formats dates and numbers in the user's locale. */
  intl: IntlShape;
  panel: ExtensionPanelSummary;
}

/**
 * An axios instance scoped to the extension's own namespace.
 *
 * Its own instance rather than the shared one, for two reasons: a `baseURL` set on
 * the default instance would redirect every core request in the app, and a panel
 * holds this object and can set defaults on it, which must not reach core.
 *
 * CSRF needs nothing here. `axios.create` merges `axios.defaults`, so the instance
 * already reads the `XSRF-TOKEN` cookie the server sets (`server/index.ts`) and
 * sends the matching header, which non-GET extension routes need. Copying
 * `xsrfCookieName`/`xsrfHeaderName` across explicitly looked load-bearing and was
 * not — removing both lines changed no behaviour and failed no test.
 */
export function createPanelApi(extensionId: string): AxiosInstance {
  return axios.create({ baseURL: `/api/v1/ext/${extensionId}/` });
}

/**
 * An SWR fetcher bound to a panel's own API instance.
 *
 * Separate from `createPanelApi` so the axios instance stays the one thing a
 * panel can also use directly for mutations, where SWR is not involved.
 */
export function createPanelFetcher(
  api: AxiosInstance
): ExtensionPanelSdk['fetcher'] {
  return async <T>(path: string): Promise<T> => {
    const response = await api.get<T>(path);
    return response.data;
  };
}
