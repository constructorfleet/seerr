/**
 * The one thing server tests cannot prove: that a panel bundle actually mounts
 * in a browser, inside the real `_app` tree.
 *
 * This exists because the panel mechanism's worst failure mode is **quiet**. A
 * panel's `import 'react'` is resolved by the import map in `_document.tsx` to
 * the host's React. If that mapping is wrong or absent, the panel gets a *second*
 * copy of React, which renders its first output perfectly and then throws on the
 * first hook — "Cannot read properties of null (reading 'useState')" or an
 * invalid-hook-call warning, at a moment unrelated to the mistake. No amount of
 * `tsc`, `eslint` or `node:test` sees it, because nothing there runs an
 * `import()` in a document with an import map.
 *
 * So the assertions below are deliberately about *hooks having run*, not about
 * markup. Watch History's panel calls `useState`, `useEffect` and `useCallback`
 * and fetches through `sdk.api` on mount; if its content appears at all, React is
 * shared and the SDK prop arrived intact.
 *
 * ## Prerequisites
 *
 * This spec needs the reference extension installed and enabled, which is not
 * something a test can arrange mid-process — discovery registers entities before
 * `dataSource.initialize()`, so an install only takes effect at boot. Run:
 *
 * ```
 * cd examples/watch-history && pnpm build && cd -
 * mkdir -p "${CONFIG_DIRECTORY:-config}/extensions"
 * cp -r examples/watch-history "${CONFIG_DIRECTORY:-config}/extensions/watch-history"
 * ln -s "$PWD/packages/extension-sdk" \
 *   "${CONFIG_DIRECTORY:-config}/extensions/watch-history/node_modules/@constructorfleet/extension-sdk"
 *
 * pnpm build
 * WITH_MIGRATIONS=true pnpm cypress:prepare
 * node -e 'const f=require("fs"),p="config/settings.json",s=JSON.parse(f.readFileSync(p));\
 *   s.extensions={...s.extensions,"watch-history":{enabled:true}};\
 *   f.writeFileSync(p,JSON.stringify(s,null,2))'
 *
 * pnpm start        # then, in another shell:
 * npx cypress run --spec cypress/e2e/extensions/panel.cy.ts
 * ```
 *
 * Two steps there are easy to get wrong and fail confusingly:
 *
 * - **`WITH_MIGRATIONS=true`.** The default `cypress:prepare` seeds via
 *   `synchronize`, leaving `migrations` empty; an extension's migrations run
 *   through the same runner, so boot then tries core's `InitialMigration` against
 *   tables that already exist and dies on `table "user" already exists`.
 * - **Enable *after* preparing.** `cypress:prepare` overwrites `settings.json`
 *   wholesale from `cypress/config/settings.cypress.json`, which has no
 *   `extensions` entry — so enabling first is silently undone and the suite
 *   skips itself.
 *
 * It is skipped rather than failed when the extension is absent, so it does not
 * break a normal `cypress run` on a checkout with no extensions installed. That
 * is a real limitation and not a happy one: a green suite does not mean this ran.
 */
describe('extension panels', () => {
  const PANEL_HREF = '/extensions/watch-history/history';

  beforeEach(() => {
    cy.loginAsAdmin();
  });

  /**
   * Asks the server what panels this user can see, and skips the suite when
   * Watch History is not among them.
   */
  const withPanel = (fn: () => void) => {
    cy.request('/api/v1/extensions/panels').then((response) => {
      const panels = response.body as { extensionId: string; href: string }[];

      if (!panels.some((panel) => panel.extensionId === 'watch-history')) {
        cy.log('watch-history is not installed; skipping');
        return;
      }

      fn();
    });
  };

  it('shows the panel in the sidebar and navigates to it', () => {
    withPanel(() => {
      // The desktop sidebar is `hidden lg:flex`, and Cypress's default viewport
      // is 1000px wide — below Tailwind's `lg`. Without this the link is in the
      // DOM but `display: none`, which reads as a panel bug rather than a
      // viewport one.
      cy.viewport(1280, 800);
      cy.visit('/');

      // The testid is contributed by `ExtensionSidebarLinks` per panel; the
      // title beside it comes from the manifest verbatim, so it is deliberately
      // not an extractable i18n message.
      cy.get('[data-testid="sidebar-extension-watch-history-history"]')
        .should('contain', 'Watch History')
        .click();
      cy.url().should('contain', PANEL_HREF);
    });
  });

  it('mounts the panel bundle with the host’s React', () => {
    withPanel(() => {
      cy.intercept('GET', '/api/v1/ext/watch-history/history*').as('history');

      cy.visit(PANEL_HREF);

      // The panel fetches on mount through `sdk.api`, which only happens if
      // `useEffect` ran — i.e. if React is the host's instance and the `sdk` prop
      // arrived. A second React copy would fail here.
      // 304 as well as 200: Express sends an ETag on the JSON, so a rerun in a
      // warm browser gets a conditional hit. Either proves the point — the
      // request was made, so `useEffect` ran under the host's React.
      cy.wait('@history')
        .its('response.statusCode')
        .should('be.oneOf', [200, 304]);

      // Rendered by the panel bundle, not by the host's loading state.
      cy.contains('Everything you have watched').should('be.visible');

      // The loader's own failure path must not have been taken.
      cy.contains('could not be loaded').should('not.exist');
      cy.contains('no default-exported component').should('not.exist');
    });
  });

  it('leaves no React hook errors in the console', () => {
    withPanel(() => {
      const errors: string[] = [];

      cy.visit(PANEL_HREF, {
        onBeforeLoad(win) {
          // Two copies of React announce themselves here rather than by
          // crashing, so the console is the only place the evidence lands.
          cy.stub(win.console, 'error').callsFake((...args: unknown[]) => {
            errors.push(args.map(String).join(' '));
          });
        },
      });

      cy.contains('Everything you have watched').should('be.visible');

      cy.then(() => {
        const hookErrors = errors.filter(
          (message) =>
            message.includes('Invalid hook call') ||
            message.includes('more than one copy of React')
        );

        expect(hookErrors, hookErrors.join('\n')).to.have.length(0);
      });
    });
  });

  it('serves the panel bundle as a module the browser can import', () => {
    withPanel(() => {
      cy.request('/api/v1/ext/watch-history/ui/history.mjs').then(
        (response) => {
          expect(response.status).to.eq(200);
          // Bare specifiers, left for the import map to resolve. An inlined React
          // here would be the bug this whole spec exists to catch.
          expect(response.body).to.contain('from "react');
          expect(response.body).to.contain('export default');
        }
      );
    });
  });
});
