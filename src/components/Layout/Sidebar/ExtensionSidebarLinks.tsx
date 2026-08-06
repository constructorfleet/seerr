/**
 * The sidebar links contributed by installed extension panels.
 *
 * A parallel rendering path rather than extra entries in `SidebarLinks`, for two
 * reasons: a core link's label is `intl.formatMessage(menuMessages[key])`, and
 * `server/i18n/extractMessages.ts` can only extract messages that exist in the
 * source at build time — an extension's title does not. So panel titles are
 * rendered verbatim, from the manifest.
 *
 * Which panels appear is decided by the server (`/api/v1/extensions/panels`),
 * already filtered to the ones this user may open, so there is no
 * `hasPermission` call here.
 */
import { extensionIcon } from '@app/components/Common/ExtensionIcon';
import type { ExtensionPanelSummary } from '@app/hooks/useExtensionPanels';
import useExtensionPanels from '@app/hooks/useExtensionPanels';
import Link from 'next/link';
import { useRouter } from 'next/router';

interface ExtensionSidebarLinksProps {
  /** Mobile links close the drawer on activation; desktop ones have nothing to close. */
  onClick?: () => void;
  variant: 'mobile' | 'desktop';
}

/**
 * Compared against `asPath`, not `pathname`: every panel shares the one
 * catch-all `pathname`, so it cannot distinguish them. Query strings are
 * trimmed so a panel with its own filters stays highlighted.
 */
const isActive = (asPath: string, panel: ExtensionPanelSummary): boolean =>
  asPath.split('?')[0] === panel.href;

const ExtensionSidebarLinks = ({
  onClick,
  variant,
}: ExtensionSidebarLinksProps) => {
  const router = useRouter();
  const { panels } = useExtensionPanels();

  const sidebarPanels = panels.filter((panel) => panel.sidebar);

  if (!sidebarPanels.length) {
    return null;
  }

  return (
    <>
      {sidebarPanels.map((panel) => {
        const Icon = extensionIcon(panel.sidebar?.icon);
        const active = isActive(router.asPath, panel);

        return (
          <Link
            key={`${variant}-extension-${panel.extensionId}-${panel.slug}`}
            href={panel.href}
            onClick={onClick}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onClick?.();
              }
            }}
            role="button"
            tabIndex={0}
            className={`flex items-center rounded-md px-2 py-2 font-medium leading-6 text-white transition duration-150 ease-in-out focus:outline-none ${
              variant === 'mobile' ? 'text-base' : 'text-lg'
            } ${
              active
                ? 'bg-gradient-to-br from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500'
                : 'hover:bg-gray-700 focus:bg-gray-700'
            } `}
            data-testid={
              variant === 'mobile'
                ? `sidebar-extension-${panel.extensionId}-${panel.slug}-mobile`
                : `sidebar-extension-${panel.extensionId}-${panel.slug}`
            }
          >
            <Icon className="mr-3 h-6 w-6" />
            {panel.title}
          </Link>
        );
      })}
    </>
  );
};

export default ExtensionSidebarLinks;
