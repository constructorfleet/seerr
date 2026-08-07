/**
 * The extension panels the signed-in user may open.
 *
 * Fetched rather than derived: a panel's permission may be an extension
 * permission, which lives in rows and so cannot be resolved against
 * `user.permissions` on the client. See
 * `server/routes/extensionSelfService.ts`.
 */
import useSWR from 'swr';

export interface ExtensionPanelSummary {
  extensionId: string;
  slug: string;
  /**
   * From the manifest. Rendered verbatim only as a fallback: an extension that
   * ships a message catalog can translate it under `<slug>.title`, which is what
   * `panelTitle` looks up. See `@app/utils/extensionMessages`.
   */
  title: string;
  href: string;
  bundleUrl: string;
  sidebar?: { icon: string; order?: number };
}

interface ExtensionPanelsHookResponse {
  panels: ExtensionPanelSummary[];
  loading: boolean;
  error: unknown;
}

export const useExtensionPanels = (): ExtensionPanelsHookResponse => {
  const { data, error } = useSWR<ExtensionPanelSummary[]>(
    '/api/v1/extensions/panels',
    {
      // Panels change only when an extension is installed or a permission is
      // granted, both of which are rare and neither of which happens while the
      // user is looking at the sidebar.
      revalidateOnFocus: false,
    }
  );

  return {
    panels: data ?? [],
    loading: !data && !error,
    error,
  };
};

/**
 * The caller's own effective extension permissions, for the panel SDK's
 * synchronous `hasPermission`. Separate from the panel list because a panel
 * gating its own UI needs the permission set even when it already knows it is
 * allowed to render.
 */
export const useOwnExtensionPermissions = (): {
  permissions: string[];
  loading: boolean;
} => {
  const { data, error } = useSWR<{ permissions: string[] }>(
    '/api/v1/extensions/permissions',
    { revalidateOnFocus: false }
  );

  return { permissions: data?.permissions ?? [], loading: !data && !error };
};

export default useExtensionPanels;
