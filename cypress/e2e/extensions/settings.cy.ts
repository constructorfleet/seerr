/**
 * The extension management page, driven through the browser.
 *
 * Unlike its sibling `panel.cy.ts`, this spec **stubs the API** and so runs on a
 * plain checkout with no extension installed. That is deliberate: the page has to
 * render four boot states, a name it does not control, and an error string written
 * by an extension, and arranging all four against a real server would mean four
 * installs, a restart each, and one of them deliberately broken. The server side of
 * each endpoint is already covered by `server/routes/settingsExtensions.test.ts`;
 * what only a browser can show is that the row renders, that the button posts, and
 * that the operator is told which of "switched off now" and "switched off at next
 * restart" happened.
 *
 * The one thing it cannot check is that the stub matches the server. `seerr-api.yml`
 * is what keeps those honest — the real responses are response-validated against it
 * in the server tests — so the shapes below are copied from `ExtensionStatus` and
 * `ExtensionEnabledState` there.
 */
interface StubExtension {
  id: string;
  name?: string;
  version?: string;
  status: 'pending' | 'active' | 'failed' | 'disabled';
  enabled: boolean;
  error?: string;
  icon?: string;
}

const ACTIVE: StubExtension = {
  id: 'watch-history',
  name: 'Watch History',
  version: '1.2.3',
  status: 'active',
  enabled: true,
  icon: 'ClockIcon',
};

describe('extension settings', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
  });

  /** Stubs the list endpoint and opens the page with it already answered. */
  const visitWith = (extensions: StubExtension[]) => {
    cy.intercept('GET', '/api/v1/settings/extensions', {
      statusCode: 200,
      body: extensions,
    }).as('list');

    cy.visit('/settings/extensions');
    cy.wait('@list');
  };

  it('lists an installed extension with its name, version and status', () => {
    visitWith([ACTIVE]);

    cy.get('[data-testid="extension-watch-history"]').within(() => {
      cy.contains('Watch History').should('be.visible');
      // The id and version, which the page renders verbatim from the manifest.
      cy.contains('1.2.3').should('be.visible');
      cy.get('[data-testid="extension-watch-history-status"]').should(
        'contain',
        'Active'
      );
    });
  });

  it('reports each boot state distinctly', () => {
    visitWith([
      ACTIVE,
      { id: 'fresh', name: 'Fresh', status: 'pending', enabled: true },
      {
        id: 'broken',
        name: 'Broken',
        status: 'failed',
        enabled: true,
        error: 'requires host API "^2.0.0"',
      },
      { id: 'off', name: 'Off', status: 'disabled', enabled: false },
    ]);

    // Four states, four different things to say. "Pending" in particular must not
    // read as success: an install that has not been restarted into is not running.
    cy.get('[data-testid="extension-fresh-status"]').should(
      'contain',
      'Pending Restart'
    );
    cy.get('[data-testid="extension-broken-status"]').should(
      'contain',
      'Failed'
    );
    cy.get('[data-testid="extension-off-status"]').should(
      'contain',
      'Disabled'
    );

    // A quarantined extension's own message, surfaced rather than swallowed — it
    // is the only thing that tells the operator what to fix.
    cy.get('[data-testid="extension-broken"]').should(
      'contain',
      'requires host API "^2.0.0"'
    );
  });

  it('offers Disable for a live extension and Enable for a switched-off one', () => {
    visitWith([
      ACTIVE,
      { id: 'off', name: 'Off', status: 'disabled', enabled: false },
    ]);

    cy.get('[data-testid="extension-watch-history-toggle"]').should(
      'contain',
      'Disable'
    );
    cy.get('[data-testid="extension-off-toggle"]').should('contain', 'Enable');
  });

  it('says the extension is switched off when disabling took effect at once', () => {
    visitWith([ACTIVE]);

    cy.intercept('POST', '/api/v1/settings/extensions/watch-history/disable', {
      statusCode: 200,
      body: { id: 'watch-history', enabled: false, restartRequired: false },
    }).as('disable');

    cy.get('[data-testid="extension-watch-history-toggle"]').click();
    cy.wait('@disable');

    // `restartRequired: false` is the host having dropped the running extension's
    // routes, jobs and listeners, so the operator must not be told to restart.
    cy.contains('is switched off').should('be.visible');
    cy.contains('will not load on the next restart').should('not.exist');
  });

  it('says a restart is needed when disabling only changed the setting', () => {
    visitWith([
      { id: 'fresh', name: 'Fresh', status: 'pending', enabled: true },
    ]);

    cy.intercept('POST', '/api/v1/settings/extensions/fresh/disable', {
      statusCode: 200,
      body: { id: 'fresh', enabled: false, restartRequired: true },
    }).as('disable');

    cy.get('[data-testid="extension-fresh-toggle"]').click();
    cy.wait('@disable');

    cy.contains('will not load on the next restart').should('be.visible');
  });

  it('always promises a restart when enabling', () => {
    visitWith([{ id: 'off', name: 'Off', status: 'disabled', enabled: false }]);

    cy.intercept('POST', '/api/v1/settings/extensions/off/enable', {
      statusCode: 200,
      body: { id: 'off', enabled: true, restartRequired: true },
    }).as('enable');

    cy.get('[data-testid="extension-off-toggle"]').click();
    cy.wait('@enable');

    // Never in place, and this is Constraint 4 rather than a gap: entities are
    // injected before the DataSource is initialized.
    cy.contains('will load on the next restart').should('be.visible');
  });

  it('surfaces the installer’s own message when a toggle fails', () => {
    visitWith([ACTIVE]);

    cy.intercept('POST', '/api/v1/settings/extensions/watch-history/disable', {
      statusCode: 500,
      body: { message: 'the disk caught fire' },
    }).as('disable');

    cy.get('[data-testid="extension-watch-history-toggle"]').click();
    cy.wait('@disable');

    cy.contains('the disk caught fire').should('be.visible');
  });

  it('takes two clicks to uninstall, and keeps grants by default', () => {
    visitWith([ACTIVE]);

    cy.intercept('DELETE', '/api/v1/settings/extensions/watch-history*', {
      statusCode: 204,
    }).as('uninstall');

    // `ConfirmButton`: the first click arms it, the second acts. Uninstalling is
    // not undoable, so a single misclick must not do it.
    cy.get('[data-testid="extension-watch-history-uninstall"]').click();
    cy.get('@uninstall.all').should('have.length', 0);

    cy.get('[data-testid="extension-watch-history-uninstall"]').click();

    // `purgeData=false` unless the operator ticked the box: permission and
    // subscription rows record their decisions about *users*, not extension data,
    // so a reinstall restores who could use it and who heard from it.
    cy.wait('@uninstall')
      .its('request.url')
      .should('contain', 'purgeData=false');
    cy.contains('uninstalled').should('be.visible');
  });

  it('asks to purge the grants when the box is ticked', () => {
    visitWith([ACTIVE]);

    cy.intercept('DELETE', '/api/v1/settings/extensions/watch-history*', {
      statusCode: 204,
    }).as('uninstall');

    cy.get('[data-testid="extension-watch-history-purge"]').check();
    cy.get('[data-testid="extension-watch-history-uninstall"]').click();
    cy.get('[data-testid="extension-watch-history-uninstall"]').click();

    cy.wait('@uninstall')
      .its('request.url')
      .should('contain', 'purgeData=true');
  });

  it('installs from a source the operator types', () => {
    visitWith([]);

    cy.intercept('POST', '/api/v1/settings/extensions', {
      statusCode: 201,
      body: {
        id: 'watch-history',
        name: 'Watch History',
        version: '1.2.3',
        replaced: false,
        restartRequired: true,
      },
    }).as('install');

    cy.get('#source').type('seerr-extension-watch-history');
    cy.get('[data-testid="settings-extensions-form"]').submit();

    cy.wait('@install')
      .its('request.body')
      .should('deep.equal', { source: 'seerr-extension-watch-history' });

    // Named in the toast, and the restart said out loud: a fresh install is
    // `pending`, and a page that showed it as active would be lying.
    cy.contains('Watch History installed').should('be.visible');
  });

  it('refuses to install with no source, without asking the server', () => {
    visitWith([]);

    cy.intercept('POST', '/api/v1/settings/extensions', {
      statusCode: 201,
      body: { id: 'nope', name: 'Nope', version: '0.0.0', replaced: false },
    }).as('install');

    cy.get('[data-testid="settings-extensions-form"]').submit();

    cy.contains('You must provide a package name or git URL').should(
      'be.visible'
    );
    // Validated client-side too, so an empty field is not a round trip that the
    // installer has to reject.
    cy.get('@install.all').should('have.length', 0);
  });

  it('reports the installer’s message when a source is rejected', () => {
    visitWith([]);

    cy.intercept('POST', '/api/v1/settings/extensions', {
      statusCode: 400,
      body: { message: 'file: specifiers are not accepted' },
    }).as('install');

    cy.get('#source').type('file:///tmp/evil');
    cy.get('[data-testid="settings-extensions-form"]').submit();
    cy.wait('@install');

    // Written by the installer, never by extension code, which is what makes it
    // safe to show — and it is the only thing that tells the operator why.
    cy.contains('file: specifiers are not accepted').should('be.visible');
  });

  it('explains the empty state rather than showing a bare list', () => {
    visitWith([]);

    cy.contains('No extensions installed').should('be.visible');
    cy.contains('npm package name or a git repository URL').should(
      'be.visible'
    );
  });

  it('links each extension to its own settings page', () => {
    visitWith([ACTIVE]);

    // A real link, so the row is navigable without JavaScript routing it.
    cy.get('[data-testid="extension-watch-history"]')
      .contains('Configure')
      .click();

    cy.url().should('contain', '/settings/extensions/watch-history');
  });
});
