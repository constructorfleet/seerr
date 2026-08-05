/**
 * The panels the signed-in user may open.
 *
 * The client needs this in two places — the sidebar links and the panel page's
 * own gate — and neither can be answered from `req.user` alone: extension
 * permissions are rows, not bits on the user, so resolving them is asynchronous
 * and belongs on the server.
 *
 * It is a *self-service* endpoint on purpose. Slice 4's permission endpoint is
 * `MANAGE_USERS`-gated and keyed by another user's id, so an ordinary user
 * cannot read their own extension permissions through it.
 *
 * A fixed core path, so unlike an extension's own routes this is documented in
 * `seerr-api.yml` and validated normally (see Constraint 3 in
 * docs/specs/extension-system.md for why extension routes cannot be).
 */
import { hasExtensionPermission } from '@server/lib/extensions/permissions';
import type { ExtensionPanel } from '@server/lib/extensions/registry';
import { getExtensionRegistry } from '@server/routes/settings/extensions';
import { Router } from 'express';

const panelListRoutes = Router();

export interface ExtensionPanelSummary {
  extensionId: string;
  slug: string;
  title: string;
  /** The client route for the panel page. */
  href: string;
  /** Where the panel's ESM bundle is served, for the page's `import()`. */
  bundleUrl: string;
  sidebar?: { icon: string; order?: number };
}

export function panelHref(panel: ExtensionPanel): string {
  return `/extensions/${panel.extensionId}/${panel.slug}`;
}

export function panelBundleUrl(panel: ExtensionPanel): string {
  return `/api/v1/ext/${panel.extensionId}/ui/${panel.slug}.mjs`;
}

/**
 * Ordered so the sidebar can render the list as it arrives: by declared order,
 * then title. A panel that states no order sorts after every panel that did, so
 * declaring one is what buys a position rather than merely a tie-break.
 */
function bySidebarOrder(
  a: ExtensionPanelSummary,
  b: ExtensionPanelSummary
): number {
  const orderA = a.sidebar?.order ?? Number.MAX_SAFE_INTEGER;
  const orderB = b.sidebar?.order ?? Number.MAX_SAFE_INTEGER;

  return orderA === orderB ? a.title.localeCompare(b.title) : orderA - orderB;
}

panelListRoutes.get('/', async (req, res, next) => {
  try {
    if (!req.user) {
      return next({ status: 403, message: 'You must be signed in.' });
    }

    const userId = req.user.id;
    // Only `active` extensions contribute panels, so a quarantined one
    // contributes no sidebar link and no reachable page.
    const panels = getExtensionRegistry()?.panels() ?? [];

    const visible = await Promise.all(
      panels.map(async (panel) => {
        if (
          panel.permission &&
          !(await hasExtensionPermission(userId, panel.permission, {
            type: 'and',
            extensionId: panel.extensionId,
          }))
        ) {
          return undefined;
        }

        const summary: ExtensionPanelSummary = {
          extensionId: panel.extensionId,
          slug: panel.slug,
          title: panel.title,
          href: panelHref(panel),
          bundleUrl: panelBundleUrl(panel),
          ...(panel.sidebar ? { sidebar: panel.sidebar } : {}),
        };

        return summary;
      })
    );

    res
      .status(200)
      .json(
        visible
          .filter(
            (panel): panel is ExtensionPanelSummary => panel !== undefined
          )
          .sort(bySidebarOrder)
      );
  } catch (e) {
    next(e);
  }
});

export default panelListRoutes;
