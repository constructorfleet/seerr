/**
 * The heroicon an extension declared, resolved from its manifest name.
 *
 * Shared rather than restated, because it used to be restated: the sidebar
 * resolved a panel's `sidebar.icon` through a map like this one while both
 * settings pages hardcoded `PuzzlePieceIcon`, so one extension had two identities
 * — a trashcan in the sidebar and a puzzle piece on its own settings page.
 * Everything that draws an extension now goes through here.
 */
import {
  ArrowPathIcon,
  BellIcon,
  BoltIcon,
  BookOpenIcon,
  ChartBarIcon,
  ClockIcon,
  CloudArrowDownIcon,
  CogIcon,
  ExclamationTriangleIcon,
  FilmIcon,
  FolderIcon,
  HeartIcon,
  InboxIcon,
  MagnifyingGlassIcon,
  PuzzlePieceIcon,
  ServerIcon,
  SparklesIcon,
  StarIcon,
  TrashIcon,
  TvIcon,
  UsersIcon,
} from '@heroicons/react/24/outline';
import type { PanelIconName } from '@server/lib/extensions/panelIcons';
import type { ComponentType, SVGProps } from 'react';

/**
 * An allowlist rather than `import * as icons`: a namespace import pulls every
 * heroicon into the client bundle, and an arbitrary manifest string is not a safe
 * component lookup anyway.
 *
 * Typed as a `Record<PanelIconName, …>` — total over the names the manifest
 * validator accepts — so adding a name to `PANEL_ICON_NAMES` without importing its
 * component here fails to compile. That totality is the point: it used to be a
 * `Record<string, …>` with a puzzle-piece fallback, so a valid manifest naming a
 * real heroicon this map happened to lack rendered as a puzzle piece with no error
 * anywhere.
 */
export const PANEL_ICONS: Record<
  PanelIconName,
  ComponentType<SVGProps<SVGSVGElement>>
> = {
  ArrowPathIcon,
  BellIcon,
  BoltIcon,
  BookOpenIcon,
  ChartBarIcon,
  ClockIcon,
  CloudArrowDownIcon,
  CogIcon,
  ExclamationTriangleIcon,
  FilmIcon,
  FolderIcon,
  HeartIcon,
  InboxIcon,
  MagnifyingGlassIcon,
  PuzzlePieceIcon,
  ServerIcon,
  SparklesIcon,
  StarIcon,
  TrashIcon,
  TvIcon,
  UsersIcon,
};

/**
 * The component for `name`, or a puzzle piece.
 *
 * The fallback survives even though the manifest validator rejects unknown names:
 * every caller reads a name off the wire, and an extension installed under an
 * older host is not revalidated. A puzzle piece beats a blank render — and it is
 * also the honest answer for an extension that declared no icon at all.
 */
export const extensionIcon = (
  name: string | undefined
): ComponentType<SVGProps<SVGSVGElement>> =>
  PANEL_ICONS[(name ?? '') as PanelIconName] ?? PuzzlePieceIcon;

/** `extensionIcon` as an element, for the common case of just drawing one. */
const ExtensionIcon = ({
  name,
  className,
}: {
  name?: string;
  className?: string;
}) => {
  const Icon = extensionIcon(name);

  return <Icon className={className} />;
};

export default ExtensionIcon;
