/**
 * The page every extension panel is served at: `/extensions/<extensionId>/<slug>`.
 *
 * A catch-all because which panels exist depends on what is installed, which is
 * not known at build time — the alternative would be regenerating routes and
 * rebuilding on every install, which is the thing runtime-loaded panels exist to
 * avoid.
 *
 * The route is resolved against the panel list the server says this user may see,
 * so a panel the user lacks permission for is indistinguishable from one that
 * does not exist. The bundle route enforces the same permission independently —
 * this is not the gate, only the UI half of it.
 */
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import ExtensionPanel from '@app/components/ExtensionPanel';
import useExtensionPanels from '@app/hooks/useExtensionPanels';
import type { NextPage } from 'next';
import { useRouter } from 'next/router';
import { useEffect } from 'react';

const ExtensionPanelPage: NextPage = () => {
  const router = useRouter();
  const { panels, loading } = useExtensionPanels();

  const slug = router.query.slug;
  const segments = Array.isArray(slug) ? slug : slug ? [slug] : [];
  const [extensionId, panelSlug] = segments;

  const panel = panels.find(
    (candidate) =>
      candidate.extensionId === extensionId && candidate.slug === panelSlug
  );

  useEffect(() => {
    // Only once the list has actually arrived: `panels` is empty while loading,
    // which would otherwise bounce every panel on first render.
    if (!loading && !panel) {
      router.push('/');
    }
  }, [loading, panel, router]);

  if (!panel) {
    return <LoadingSpinner />;
  }

  return <ExtensionPanel panel={panel} />;
};

export default ExtensionPanelPage;
