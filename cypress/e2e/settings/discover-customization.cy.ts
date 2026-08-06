describe('Discover Customization', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
    cy.intercept('/api/v1/settings/discover').as('getDiscoverSliders');
  });

  it('show the discover customization settings', () => {
    cy.visit('/');

    cy.get('[data-testid=discover-start-editing]').click();

    cy.get('[data-testid=create-slider-header')
      .should('contain', 'Create New Slider')
      .scrollIntoView();

    // There should be some built in options
    cy.get('[data-testid=discover-slider-edit-mode]').should(
      'contain',
      'Recently Added'
    );
    cy.get('[data-testid=discover-slider-edit-mode]').should(
      'contain',
      'Recent Requests'
    );
  });

  it('can drag to re-order elements and save to persist the changes', () => {
    cy.visit('/');

    cy.get('[data-testid=discover-start-editing]').click();

    /** Drags row 0 onto row 1, which swaps them. */
    const swapFirstTwo = () => {
      const dataTransfer = new DataTransfer();

      cy.get('[data-testid=discover-slider-edit-mode]')
        .first()
        .trigger('dragstart', { dataTransfer });
      cy.get('[data-testid=discover-slider-edit-mode]')
        .eq(1)
        .trigger('drop', { dataTransfer });
      cy.get('[data-testid=discover-slider-edit-mode]')
        .eq(1)
        .trigger('dragend', { dataTransfer });
    };

    // Whatever the first two sliders *are* is not what this test is about — the
    // claim is that a drag swaps them and the swap survives a reload. Reading the
    // titles first rather than hardcoding 'Recently Added'/'Recent Requests' keeps
    // it from failing whenever the default order or the seeded set changes, which
    // is what made it flaky. The title is read from its own node, not from the
    // row: the row also renders a preview of the slider, whose header repeats the
    // title, so the row's text is the title twice over.
    cy.get('[data-testid=discover-slider-title]')
      .first()
      .invoke('text')
      .then((firstTitle) => {
        swapFirstTwo();

        cy.get('[data-testid=discover-slider-title]')
          .eq(1)
          .should('have.text', firstTitle);

        cy.get('[data-testid=discover-customize-submit').click();
        cy.wait('@getDiscoverSliders');

        cy.reload();

        cy.get('[data-testid=discover-start-editing]').click();

        // Persisted, not merely re-rendered.
        cy.get('[data-testid=discover-slider-title]')
          .eq(1)
          .should('have.text', firstTitle);

        // Swap back, so the test leaves the order it found. Without this the
        // stored order depends on how many times the suite has run.
        swapFirstTwo();

        cy.get('[data-testid=discover-slider-title]')
          .first()
          .should('have.text', firstTitle);

        cy.get('[data-testid=discover-customize-submit').click();
        cy.wait('@getDiscoverSliders');
      });
  });

  it('can create a new discover option and remove it', () => {
    cy.visit('/');
    cy.intercept('/api/v1/settings/discover/*').as('discoverSlider');
    cy.intercept('/api/v1/search/keyword*').as('searchKeyword');

    cy.get('[data-testid=discover-start-editing]').click();

    const sliderTitle = 'Custom Keyword Slider';

    cy.get('#sliderType').select('TMDB Movie Keyword');

    cy.get('#title').type(sliderTitle);
    // First confirm that an invalid keyword doesn't allow us to submit anything
    cy.get('#data').type('invalidkeyword{enter}', { delay: 100 });
    cy.wait('@searchKeyword');

    cy.get('[data-testid=create-discover-option-form]')
      .find('button')
      .should('be.disabled');

    cy.get('#data').clear();
    cy.get('#data').type('christmas{enter}', { delay: 100 });

    // Confirming we have some results
    cy.contains('.slider-header', sliderTitle)
      .next('[data-testid=media-slider]')
      .find('[data-testid=title-card]');

    cy.get('[data-testid=create-discover-option-form]').submit();

    cy.wait('@discoverSlider');
    cy.wait('@getDiscoverSliders');

    // Asserted over the whole collection rather than `.first()`: a new slider's
    // position is the server's business, and asserting it is row 0 makes the test
    // fail on an ordering change that is not what it is testing. Cypress retries
    // this until the re-render lands, so it also removes the `cy.wait(1000)` that
    // was standing in for it.
    cy.get('[data-testid=discover-slider-edit-mode]').should(
      'contain',
      sliderTitle
    );

    // Make sure its still there even if we reload
    cy.reload();

    cy.get('[data-testid=discover-start-editing]').click();

    cy.get('[data-testid=discover-slider-edit-mode]').should(
      'contain',
      sliderTitle
    );

    // Verify it's not rendering on our discover page (its still disabled!)
    cy.visit('/');

    cy.get('.slider-header').should('not.contain', sliderTitle);

    cy.get('[data-testid=discover-start-editing]').click();

    // Enable it, and check again. Found by title rather than by position, for the
    // same reason as above.
    cy.contains('[data-testid=discover-slider-edit-mode]', sliderTitle)
      .find('[role="checkbox"]')
      .click();

    cy.get('[data-testid=discover-customize-submit').click();
    cy.wait('@getDiscoverSliders');

    cy.visit('/');

    cy.contains('.slider-header', sliderTitle)
      .next('[data-testid=media-slider]')
      .find('[data-testid=title-card]');

    cy.get('[data-testid=discover-start-editing]').click();

    // let's delete it and confirm its deleted. The row is found by its title, so
    // this deletes the slider this test created rather than whichever one happens
    // to be first.
    cy.contains('[data-testid=discover-slider-edit-mode]', sliderTitle)
      .find('[data-testid=discover-slider-remove-button]')
      .click();

    cy.wait('@discoverSlider');
    cy.wait('@getDiscoverSliders');

    // No row anywhere contains it, which is the actual claim — `.first()` would
    // pass as soon as the deleted slider was merely no longer at the top.
    cy.get('[data-testid=discover-slider-edit-mode]').should(
      'not.contain',
      sliderTitle
    );
  });
});
