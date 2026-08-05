/**
 * The heroicon names a panel's sidebar entry may name.
 *
 * One list, here, because the two places that care sit on opposite sides of the
 * client/server line and drifted apart: the manifest validator accepted any
 * `*Icon`-shaped string, while the sidebar resolves the name through an explicit
 * allowlist map. A name in a valid manifest that the map did not have — `TrashIcon`
 * was the one that bit — validated, installed, and then rendered as the generic
 * puzzle piece with nothing anywhere saying why.
 *
 * It lives under `server/` rather than `src/` because of the direction imports
 * are allowed to run: `src/` may import `@server/*`, but the server tsconfig has
 * no path for `@app/*`, so the validator could not have read a client-side list.
 *
 * Adding a name here is the whole of adding an icon: `manifest.ts` starts
 * accepting it and the sidebar map is keyed off this list, so an entry with no
 * corresponding import is a compile error rather than a silent fallback.
 */
export const PANEL_ICON_NAMES = [
  'ArrowPathIcon',
  'BellIcon',
  'BoltIcon',
  'BookOpenIcon',
  'ChartBarIcon',
  'ClockIcon',
  'CloudArrowDownIcon',
  'CogIcon',
  'ExclamationTriangleIcon',
  'FilmIcon',
  'FolderIcon',
  'HeartIcon',
  'InboxIcon',
  'MagnifyingGlassIcon',
  'PuzzlePieceIcon',
  'ServerIcon',
  'SparklesIcon',
  'StarIcon',
  'TrashIcon',
  'TvIcon',
  'UsersIcon',
] as const;

export type PanelIconName = (typeof PANEL_ICON_NAMES)[number];
