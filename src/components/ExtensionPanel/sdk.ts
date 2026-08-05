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
