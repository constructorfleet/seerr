/**
 * The extension panels the signed-in user may open.
 *
 * Fetched rather than derived: a panel's permission may be an extension
 * permission, which lives in rows and so cannot be resolved against
 * `user.permissions` on the client. See
 * `server/routes/extensionPanelsList.ts`.
 */
import useSWR from 'swr';

export interface ExtensionPanelSummary {
  extensionId: string;
  slug: string;
  /** From the manifest, and shown verbatim — extension titles are not translatable. */
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

export default useExtensionPanels;
