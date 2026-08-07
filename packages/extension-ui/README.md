# @constructorfleet/extension-ui

Seerr's own UI components, for extension panels that want to look like Seerr.

```tsx
import type { ExtensionPanelSdk } from '@constructorfleet/extension-ui';
import { Alert, Button, LoadingSpinner, Table } from '@constructorfleet/extension-ui';
import useSWR from 'swr';

export default function Panel({ sdk }: { sdk: ExtensionPanelSdk }) {
  const { data, error } = useSWR<{ results: Item[] }>('/items', sdk.fetcher);

  if (error) return <Alert title="Could not load items" type="error" />;
  if (!data) return <LoadingSpinner />;

  return (
    <Button buttonType="primary" onClick={() => sdk.notify('Done', 'success')}>
      {data.results.length} items
    </Button>
  );
}
```

## Why this exists

**A panel cannot style itself with Tailwind.** A panel is a pre-built bundle loaded at
runtime, so Seerr's Tailwind build never sees its class names — and Tailwind emits CSS
only for classes it found while scanning Seerr's own source. A panel writing
`className="gap-7"` gets a class that does not exist: it renders unstyled, with no error
in the console or the server log.

Some utility classes do work, but only by coincidence — they happen to appear somewhere in
Seerr's source, so Tailwind emitted them for its own sake. That is not something to rely
on; it changes whenever Seerr's markup changes.

These components are the way out. They are Seerr's *actual* components, the same instances
the surrounding page renders with, so their styles are guaranteed to be present and a
Seerr retheme reaches your panel with no release on your part.

Two class groups are also safe to use directly, being hand-written CSS rather than
Tailwind-generated: the semantic helpers in Seerr's `globals.css` (`heading`,
`description`, `card-field`, `card-field-name`, `button-md`, `avatar-sm`).

## Installation

```sh
npm install --save-dev @constructorfleet/extension-ui
```

A **dev dependency**: at runtime Seerr's import map redirects `@constructorfleet/extension-ui` to the
running host, so nothing from this package is bundled into your panel. Installing it gives
you types.

Do not add `react` as a dependency either — it is a peer. A second copy of React renders
correctly and then throws on your first hook.

## Available components

`Accordion`, `Alert`, `Badge`, `Button`, `ButtonWithDropdown`, `CachedImage`,
`ConfirmButton`, `Dropdown`, `Header`, `ImageFader`, `LabeledCheckbox`, `List`,
`LoadingSpinner`, `Modal`, `MultiRangeSlider`, `PageTitle`, `PlayButton`,
`ProgressCircle`, `SensitiveInput`, `SlideCheckbox`, `SlideOver`, `StatusBadgeMini`,
`Table`, `Tag`, `Tooltip`.

Prop types come from Seerr itself, so your editor has the real ones. Two notes:

- `LabeledCheckbox` and `SensitiveInput` use Formik's `Field` internally, so they need a
  `<Formik>` ancestor. A panel not already using Formik should use a plain input.
- `CachedImage` and `PageTitle` read Seerr's settings context. That works — a panel renders
  inside the host's provider tree.

## Data fetching

`swr` is provided by the host, so `import useSWR from 'swr'` gets Seerr's instance. **Pass
`sdk.fetcher` explicitly:**

```tsx
const { data } = useSWR('/items', sdk.fetcher);   // ✅ your extension's route
const { data } = useSWR('/items');                // ❌ resolves against core's /api/v1
```

Seerr's global fetcher is configured for its own API. `sdk.fetcher` wraps `sdk.api`, which
is pre-scoped to `/api/v1/ext/<your-id>/`, so a relative key reaches your own routes. For
mutations use `sdk.api` directly — it carries the CSRF header that non-GET routes need.

Remember that the panel is the *optional* half of an extension. Anything your UI needs
should be assembled by your server half and served from your own route; the server SDK has
`sdk.media.getDetails` for titles, years and ready-to-use image URLs, so a panel never
needs to know TMDB's path conventions.

## Versioning

This package tracks the Seerr release it ships with, and a panel is loaded by whatever
Seerr the operator runs. Treat the version as a *minimum*: types describe the release you
built against, and the components at runtime are the host's.

## License

MIT
