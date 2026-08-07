import type { IntlShape } from 'react-intl';

/**
 * Translates an extension-supplied string, falling back to what the manifest
 * said.
 *
 * Extension catalogs are merged into core's message map under an
 * `<extensionId>.<key>` namespace (see
 * `server/lib/extensions/messages.ts`), so a title is translatable by declaring
 * `<slug>.title` in the catalog. An extension that ships no catalog — or ships
 * one without that key — keeps rendering its manifest title verbatim, which is
 * the behaviour every extension had before catalogs existed.
 *
 * `intl.formatMessage` cannot express that fallback on its own: given an unknown
 * id and no `defaultMessage` it returns the id itself, so a panel with no catalog
 * would render `watch-history.history.title` in the sidebar. Hence the explicit
 * membership check against `intl.messages`.
 */
export const translateExtensionString = (
  intl: IntlShape,
  extensionId: string,
  key: string,
  fallback: string
): string => {
  const id = `${extensionId}.${key}`;

  return id in intl.messages
    ? intl.formatMessage({ id, defaultMessage: fallback })
    : fallback;
};

/**
 * A panel's title, translated from `<slug>.title` when the extension ships it.
 *
 * Keyed by slug rather than a bare `title` so an extension with several panels
 * can translate each one.
 */
export const panelTitle = (
  intl: IntlShape,
  panel: { extensionId: string; slug: string; title: string }
): string =>
  translateExtensionString(
    intl,
    panel.extensionId,
    `${panel.slug}.title`,
    panel.title
  );

export default translateExtensionString;
