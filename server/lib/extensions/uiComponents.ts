/**
 * The host components a panel may import from `@constructorfleet/extension-ui`.
 *
 * Why a hand-written list, when the other shared modules derive their export
 * names by enumerating the installed module object: this one's module lives in
 * `src/`, and the server cannot import from there (the server tsconfig has no
 * `@app/*` path, deliberately). The shim generator needs the names at process
 * start, so they are declared here — in a file that imports nothing, which is
 * what lets both sides read it.
 *
 * The drift that would otherwise be silent is made a compile error instead:
 * `src/components/ExtensionUi/index.ts` types its export object as a `Record`
 * over this union, so a name here with no component there fails to build.
 *
 * ## Why re-export at all
 *
 * A panel is a pre-built bundle, so the host's Tailwind build never sees its
 * class names — `content` in `tailwind.config.js` globs only `./src/pages/**` and
 * `./src/components/**`, and JIT emits nothing it did not find there. A panel
 * writing `className="gap-7"` gets a class that does not exist: it renders
 * unstyled, with no error anywhere. (The example panels look right today partly
 * by luck — every utility they use happens to appear somewhere in host source.)
 *
 * Re-exporting the host's own components is the fix that cannot drift, because
 * their classes are compiled into the host bundle by virtue of living under
 * `src/components/**`. It also means a retheme reaches every panel at once,
 * rather than every panel carrying a stale copy of the design tokens.
 *
 * ## What is deliberately absent
 *
 * Three of `Common/`'s components are bound to host pages rather than to the
 * visual language, so exposing them would promise compatibility for markup a
 * panel cannot sensibly use:
 *
 * - `ListView` — takes TMDB discover result unions and renders host title cards.
 * - `QuickConnectModal` — one specific host settings flow, not a general modal.
 *   Panels wanting a modal get `Modal`.
 * - `SettingsTabs` — routes between host settings pages via `next/router`.
 *
 * Everything else is here. Note that components using host React context
 * (`CachedImage` and `PageTitle` read `useSettings`) work fine: a panel renders
 * *inside* the host's provider tree, so the context is already above it.
 */
export const UI_COMPONENT_NAMES = [
  'Accordion',
  'Alert',
  'Badge',
  'Button',
  'ButtonWithDropdown',
  'CachedImage',
  'ConfirmButton',
  'Dropdown',
  'Header',
  'ImageFader',
  'LabeledCheckbox',
  'List',
  'LoadingSpinner',
  'Modal',
  'MultiRangeSlider',
  'PageTitle',
  'PlayButton',
  'ProgressCircle',
  'SensitiveInput',
  'SlideCheckbox',
  'SlideOver',
  'StatusBadgeMini',
  'Table',
  'Tabs',
  'Tag',
  'Tooltip',
] as const;

export type UiComponentName = (typeof UI_COMPONENT_NAMES)[number];
