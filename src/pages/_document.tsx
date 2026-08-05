import type { DocumentContext, DocumentInitialProps } from 'next/document';
import Document, { Head, Html, Main, NextScript } from 'next/document';

import { sharedModuleImportMap } from '@server/lib/extensions/sharedModuleSpecifiers';

import type { JSX } from 'react';

/**
 * Redirects an extension panel's bare imports to the host's own modules.
 *
 * The map only has to exist before the first dynamic `import()` of a panel
 * bundle. It has no effect on Next's own chunks, which are classic
 * `<script defer>` rather than modules — which is also why a panel cannot simply
 * reuse the app's script tags and needs this instead.
 *
 * Built from the server's specifier list so the two cannot drift, and tagged with
 * the build so a Seerr upgrade busts any cached shim.
 */
const SHARED_MODULE_IMPORT_MAP = sharedModuleImportMap(
  process.env.commitTag ?? 'local'
);

class MyDocument extends Document {
  static async getInitialProps(
    ctx: DocumentContext
  ): Promise<DocumentInitialProps> {
    const initialProps = await Document.getInitialProps(ctx);

    return initialProps;
  }

  render(): JSX.Element {
    return (
      <Html>
        <Head>
          <script
            type="importmap"
            dangerouslySetInnerHTML={{ __html: SHARED_MODULE_IMPORT_MAP }}
          />
        </Head>
        <body>
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}

export default MyDocument;
