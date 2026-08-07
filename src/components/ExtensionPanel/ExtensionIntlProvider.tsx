/**
 * `IntlProvider`, with every installed extension's strings merged into core's.
 *
 * ## Why merged rather than scoped
 *
 * The obvious design is a nested `IntlProvider` around each panel holding only
 * that extension's catalog. It does not work: a nested provider *replaces* the
 * message map for its subtree, and a panel renders host components from
 * `@seerr/extension-ui` that look up core's message ids. Scoping that way would
 * leave every button and empty state inside a panel rendering as a raw id.
 *
 * Merging is safe because the server namespaces every extension key with its
 * extension id (`watch-history.title`; see `server/lib/extensions/messages.ts`),
 * so a catalog cannot shadow a core message or another extension's.
 *
 * It also has to be here rather than around the panel, because a panel bundle is
 * not the only place these strings appear — the sidebar label and page title are
 * rendered by core, outside any panel and before its bundle has loaded.
 */
import type { AvailableLocale } from '@server/types/languages';
import { IntlProvider } from 'react-intl';
import useSWR from 'swr';

interface ExtensionIntlProviderProps {
  locale: AvailableLocale;
  messages: Record<string, string>;
  children: React.ReactNode;
}

const ExtensionIntlProvider = ({
  locale,
  messages,
  children,
}: ExtensionIntlProviderProps) => {
  // Keyed by locale so switching language refetches: catalogs are resolved
  // server-side, where the fallback chain and partial-translation merge live, so
  // the client cannot re-derive another locale from what it already has.
  const { data: extensionMessages } = useSWR<Record<string, string>>(
    `/api/v1/extensions/messages?locale=${locale}`,
    {
      // A catalog changes only when an extension is installed or upgraded.
      revalidateOnFocus: false,
      // Signed-out visitors get a 403 here, which is not worth retrying — the
      // login page has no extension strings on it.
      shouldRetryOnError: false,
    }
  );

  return (
    <IntlProvider
      locale={locale}
      defaultLocale="en"
      // Core last: an extension cannot override a core string even if the
      // namespacing that prevents collisions were ever to regress.
      messages={{ ...extensionMessages, ...messages }}
    >
      {children}
    </IntlProvider>
  );
};

export default ExtensionIntlProvider;
