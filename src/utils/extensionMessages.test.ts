/**
 * Resolving extension-supplied strings against the merged message catalog.
 *
 * The whole point of this module is a fallback `intl.formatMessage` cannot
 * express: given an unknown id and no `defaultMessage` it returns *the id*, so an
 * extension shipping no catalog would put `watch-history.history.title` in the
 * sidebar where its name belongs. These tests pin that, and pin that a catalog
 * really does win when it exists — the two halves are easy to get individually
 * right and collectively wrong.
 *
 * `IntlShape` is faked rather than built with `createIntl`, because what is under
 * test is the membership check and the delegation, not `react-intl`'s formatting.
 * A real `IntlShape` would also drag in a component tree this runner has no DOM
 * for.
 */
import {
  panelTitle,
  translateExtensionString,
} from '@app/utils/extensionMessages';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IntlShape } from 'react-intl';

/** Records what `formatMessage` was asked for, so delegation is observable. */
function fakeIntl(messages: Record<string, string>): {
  intl: IntlShape;
  calls: { id: string; defaultMessage?: string }[];
} {
  const calls: { id: string; defaultMessage?: string }[] = [];

  const intl = {
    messages,
    formatMessage: (descriptor: { id?: string; defaultMessage?: string }) => {
      calls.push({
        id: String(descriptor.id),
        defaultMessage: descriptor.defaultMessage,
      });

      return messages[String(descriptor.id)] ?? String(descriptor.id);
    },
  } as unknown as IntlShape;

  return { intl, calls };
}

describe('translating an extension-supplied string', () => {
  it('uses the catalog entry when the extension ships one', () => {
    const { intl } = fakeIntl({ 'demo.greeting': 'Guten Tag' });

    assert.equal(
      translateExtensionString(intl, 'demo', 'greeting', 'Hello'),
      'Guten Tag'
    );
  });

  it('namespaces the key under the extension id', () => {
    // Two extensions may both declare `greeting`; neither may answer for the
    // other. The namespace is applied here rather than by the catalog loader
    // being trusted, so a bare key never reaches `intl`.
    const { intl, calls } = fakeIntl({ 'demo.greeting': 'Guten Tag' });

    translateExtensionString(intl, 'demo', 'greeting', 'Hello');

    assert.deepEqual(calls, [{ id: 'demo.greeting', defaultMessage: 'Hello' }]);
  });

  it('does not answer with another extension’s translation of the same key', () => {
    const { intl } = fakeIntl({ 'other.greeting': 'Guten Tag' });

    assert.equal(
      translateExtensionString(intl, 'demo', 'greeting', 'Hello'),
      'Hello'
    );
  });

  it('falls back to the manifest string when no catalog was shipped', () => {
    const { intl, calls } = fakeIntl({});

    assert.equal(
      translateExtensionString(intl, 'demo', 'greeting', 'Hello'),
      'Hello'
    );

    // And without going through `formatMessage` at all — which is the fix. Asked
    // for an unknown id it would return `'demo.greeting'`, and react-intl would
    // log a missing-message error for a string that is not missing.
    assert.deepEqual(calls, []);
  });

  it('falls back for an extension that ships a catalog without this key', () => {
    // The common case as an extension grows: some strings translated, some not.
    const { intl } = fakeIntl({ 'demo.other': 'Etwas' });

    assert.equal(
      translateExtensionString(intl, 'demo', 'greeting', 'Hello'),
      'Hello'
    );
  });
});

describe('a panel’s title', () => {
  const panel = {
    extensionId: 'watch-history',
    slug: 'history',
    title: 'Watch History',
  };

  it('is translated from the panel’s own slug', () => {
    // Keyed by slug so an extension with several panels can translate each one,
    // rather than all of them sharing one `title`.
    const { intl } = fakeIntl({ 'watch-history.history.title': 'Sehverlauf' });

    assert.equal(panelTitle(intl, panel), 'Sehverlauf');
  });

  it('is not translated by another panel’s title key', () => {
    const { intl } = fakeIntl({ 'watch-history.stats.title': 'Statistik' });

    assert.equal(panelTitle(intl, panel), 'Watch History');
  });

  it('is the manifest title when the extension ships no catalog', () => {
    const { intl } = fakeIntl({});

    assert.equal(panelTitle(intl, panel), 'Watch History');
  });
});
