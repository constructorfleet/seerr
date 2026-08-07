/**
 * Loads and renders one extension panel.
 *
 * The panel arrives as a pre-built ESM bundle fetched at runtime, so nothing
 * about it is known to this build — not its code, not its types. What makes it
 * render as part of Seerr rather than as an island is that its `import 'react'`
 * resolves to *this* React instance, via the import map in `_document.tsx` and
 * the global published by `@app/utils/extensionSharedModules`. That is also why
 * this component is unremarkable: once the panel shares React, it is just a
 * component in the tree, inside Layout, `SWRConfig` and `IntlProvider` like any
 * other page's content.
 *
 * `import(/* webpackIgnore *\/ …)` is required: the URL is only known at runtime,
 * and webpack would otherwise try to resolve and bundle it at build time.
 */
import Alert from '@app/components/Common/Alert';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import PanelErrorBoundary from '@app/components/ExtensionPanel/PanelErrorBoundary';
import type { ExtensionPanelSdk } from '@app/components/ExtensionPanel/sdk';
import {
  createPanelApi,
  createPanelFetcher,
} from '@app/components/ExtensionPanel/sdk';
import type { ExtensionPanelSummary } from '@app/hooks/useExtensionPanels';
import { useOwnExtensionPermissions } from '@app/hooks/useExtensionPanels';
import { useUser } from '@app/hooks/useUser';
import { panelTitle } from '@app/utils/extensionMessages';
import type { ComponentType } from 'react';
import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useIntl } from 'react-intl';

interface ExtensionPanelProps {
  panel: ExtensionPanelSummary;
}

type PanelComponent = ComponentType<{ sdk: ExtensionPanelSdk }>;

const ExtensionPanel = ({ panel }: ExtensionPanelProps) => {
  const intl = useIntl();
  const { user } = useUser();
  const { permissions } = useOwnExtensionPermissions();
  const [PanelComponent, setPanelComponent] = useState<PanelComponent>();
  const [loadError, setLoadError] = useState<string>();

  const { bundleUrl } = panel;

  // Translated when the extension ships a catalog with `<slug>.title`, and the
  // manifest's verbatim title otherwise.
  const title = panelTitle(intl, panel);

  useEffect(() => {
    let cancelled = false;

    setPanelComponent(undefined);
    setLoadError(undefined);

    import(/* webpackIgnore: true */ bundleUrl)
      .then((mod: { default?: PanelComponent }) => {
        if (cancelled) {
          return;
        }

        if (typeof mod.default !== 'function') {
          setLoadError('The panel bundle has no default-exported component.');
          return;
        }

        // Wrapped in a thunk: React treats a bare function passed to a state
        // setter as an updater, and would call the component instead of storing
        // it.
        setPanelComponent(() => mod.default);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      });

    // Navigating away mid-fetch must not set state on an unmounted component,
    // and switching panels must not let a slow earlier bundle win.
    return () => {
      cancelled = true;
    };
  }, [bundleUrl]);

  const api = useMemo(
    () => createPanelApi(panel.extensionId),
    [panel.extensionId]
  );

  const fetcher = useMemo(() => createPanelFetcher(api), [api]);

  const sdk = useMemo<ExtensionPanelSdk | undefined>(() => {
    if (!user) {
      return undefined;
    }

    const granted = new Set(permissions);

    return {
      user,
      // Synchronous because the effective set is already fetched. A bare key is
      // namespaced against this panel's own extension, matching how the manifest
      // and the server-side check treat it.
      hasPermission: (permission) =>
        (Array.isArray(permission) ? permission : [permission]).every((key) =>
          granted.has(key.includes(':') ? key : `${panel.extensionId}:${key}`)
        ),
      api,
      fetcher,
      notify: (message, type) => {
        if (type === 'error') {
          toast.error(message);
        } else if (type === 'success') {
          toast.success(message);
        } else {
          toast(message);
        }
      },
      intl,
      panel,
    };
  }, [user, permissions, api, fetcher, intl, panel]);

  if (loadError !== undefined) {
    return (
      <>
        <PageTitle title={title} />
        <Alert title={`The ${title} panel could not be loaded`}>
          {loadError}
        </Alert>
      </>
    );
  }

  if (!PanelComponent || !sdk) {
    return (
      <>
        <PageTitle title={title} />
        <LoadingSpinner />
      </>
    );
  }

  return (
    <>
      <PageTitle title={title} />
      <PanelErrorBoundary title={title}>
        <PanelComponent sdk={sdk} />
      </PanelErrorBoundary>
    </>
  );
};

export default ExtensionPanel;
