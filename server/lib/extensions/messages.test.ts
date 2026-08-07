import {
  extensionMessageCatalog,
  loadExtensionMessages,
} from '@server/lib/extensions/messages';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'seerr-ext-messages-'));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

/** Writes `<directory>/<relative>/<locale>.json`. */
async function writeCatalog(
  relative: string,
  locale: string,
  messages: Record<string, string> | string
) {
  const target = path.join(directory, relative);

  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(
    path.join(target, `${locale}.json`),
    typeof messages === 'string' ? messages : JSON.stringify(messages)
  );
}

describe('loadExtensionMessages', () => {
  it('returns the catalog for the requested locale', async () => {
    await writeCatalog('i18n', 'de', { title: 'Verlauf' });

    const messages = await loadExtensionMessages({
      id: 'demo',
      directory,
      messages: 'i18n',
      locale: 'de',
    });

    assert.deepStrictEqual(messages, { 'demo.title': 'Verlauf' });
  });

  it('namespaces every key with the extension id', async () => {
    // The catalogs are merged into core's message map, so an unprefixed key
    // could shadow a core message. Prefixing here rather than asking authors to
    // do it makes the collision impossible rather than merely discouraged.
    await writeCatalog('i18n', 'en', {
      title: 'History',
      'empty.state': 'Nothing yet',
    });

    const messages = await loadExtensionMessages({
      id: 'watch-history',
      directory,
      messages: 'i18n',
      locale: 'en',
    });

    assert.deepStrictEqual(messages, {
      'watch-history.title': 'History',
      'watch-history.empty.state': 'Nothing yet',
    });
  });

  it('falls back to English for a locale the extension does not ship', async () => {
    await writeCatalog('i18n', 'en', { title: 'History' });

    const messages = await loadExtensionMessages({
      id: 'demo',
      directory,
      messages: 'i18n',
      locale: 'fr',
    });

    assert.deepStrictEqual(messages, { 'demo.title': 'History' });
  });

  it('fills gaps in a partial translation from English', async () => {
    // A half-translated catalog is the normal state of a translation effort.
    // Without this the untranslated keys render as raw ids.
    await writeCatalog('i18n', 'en', {
      title: 'History',
      empty: 'Nothing yet',
    });
    await writeCatalog('i18n', 'de', { title: 'Verlauf' });

    const messages = await loadExtensionMessages({
      id: 'demo',
      directory,
      messages: 'i18n',
      locale: 'de',
    });

    assert.deepStrictEqual(messages, {
      'demo.title': 'Verlauf',
      'demo.empty': 'Nothing yet',
    });
  });

  it('matches a regional locale against its base language', async () => {
    // Core's locales include `pt-BR` and `zh-Hans`; an extension shipping only
    // `pt` should still serve a `pt-BR` user rather than falling to English.
    await writeCatalog('i18n', 'en', { title: 'History' });
    await writeCatalog('i18n', 'pt', { title: 'Histórico' });

    const messages = await loadExtensionMessages({
      id: 'demo',
      directory,
      messages: 'i18n',
      locale: 'pt-BR',
    });

    assert.deepStrictEqual(messages, { 'demo.title': 'Histórico' });
  });

  it('returns nothing when the extension declares no catalogs', async () => {
    const messages = await loadExtensionMessages({
      id: 'demo',
      directory,
      locale: 'en',
    });

    assert.deepStrictEqual(messages, {});
  });

  it('returns nothing when the declared directory does not exist', async () => {
    // Not an error: a manifest can outlive a build that forgot to emit them,
    // and a missing catalog should degrade to untranslated rather than break
    // the panel.
    const messages = await loadExtensionMessages({
      id: 'demo',
      directory,
      messages: 'i18n',
      locale: 'en',
    });

    assert.deepStrictEqual(messages, {});
  });

  it('returns nothing when a catalog is not valid JSON', async () => {
    await writeCatalog('i18n', 'en', '{ not json');

    const messages = await loadExtensionMessages({
      id: 'demo',
      directory,
      messages: 'i18n',
      locale: 'en',
    });

    assert.deepStrictEqual(messages, {});
  });

  it('ignores values that are not strings', async () => {
    // These reach `IntlProvider`, which expects strings. A nested object would
    // be silently mis-rendered; dropping it keeps the map well-typed.
    await writeCatalog(
      'i18n',
      'en',
      JSON.stringify({
        title: 'History',
        nested: { deep: 'no' },
        count: 3,
      })
    );

    const messages = await loadExtensionMessages({
      id: 'demo',
      directory,
      messages: 'i18n',
      locale: 'en',
    });

    assert.deepStrictEqual(messages, { 'demo.title': 'History' });
  });

  it('refuses a catalog path that escapes the extension directory', async () => {
    // The schema rejects this shape, but the check is repeated here for the
    // same reason the panel bundle route repeats its own: this function reads
    // files off disk, and it should not depend on an earlier validation having
    // run to stay inside the extension.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'seerr-outside-'));

    await fs.writeFile(
      path.join(outside, 'en.json'),
      JSON.stringify({ title: 'nope' })
    );

    const messages = await loadExtensionMessages({
      id: 'demo',
      directory,
      messages: path.relative(directory, outside),
      locale: 'en',
    });

    assert.deepStrictEqual(messages, {});

    await fs.rm(outside, { recursive: true, force: true });
  });

  it('refuses a catalog directory that is a symlink out of the extension', async () => {
    // `path.resolve` arithmetic cannot see this: `i18n` is textually inside the
    // extension directory, and the catalogs it points at outside were read.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'seerr-outside-'));

    await fs.writeFile(
      path.join(outside, 'en.json'),
      JSON.stringify({ title: 'nope' })
    );
    await fs.symlink(outside, path.join(directory, 'i18n'));

    const messages = await loadExtensionMessages({
      id: 'demo',
      directory,
      messages: 'i18n',
      locale: 'en',
    });

    assert.deepStrictEqual(messages, {});

    await fs.rm(outside, { recursive: true, force: true });
  });

  it('refuses a single catalog file symlinked out of the extension', async () => {
    // The directory is contained, but each file in it is a separate symlink
    // target — so containment is checked per file as well.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'seerr-outside-'));

    await fs.writeFile(
      path.join(outside, 'secrets.json'),
      JSON.stringify({ title: 'nope' })
    );
    await fs.mkdir(path.join(directory, 'i18n'), { recursive: true });
    await fs.symlink(
      path.join(outside, 'secrets.json'),
      path.join(directory, 'i18n', 'en.json')
    );

    const messages = await loadExtensionMessages({
      id: 'demo',
      directory,
      messages: 'i18n',
      locale: 'en',
    });

    assert.deepStrictEqual(messages, {});

    await fs.rm(outside, { recursive: true, force: true });
  });

  it('reads a locale name literally rather than as a path', async () => {
    // The locale arrives from a user setting, so it is the one input here a
    // request influences. It indexes a filename and must not be able to
    // traverse out of the catalog directory.
    await writeCatalog('i18n', 'en', { title: 'History' });

    const messages = await loadExtensionMessages({
      id: 'demo',
      directory,
      messages: 'i18n',
      locale: '../../../../etc/passwd',
    });

    // Falls back to English rather than reading anything it was pointed at.
    assert.deepStrictEqual(messages, { 'demo.title': 'History' });
  });
});

describe('extensionMessageCatalog', () => {
  it('merges every extension into one map', async () => {
    const second = await fs.mkdtemp(path.join(os.tmpdir(), 'seerr-ext-two-'));

    await writeCatalog('i18n', 'en', { title: 'History' });
    await fs.mkdir(path.join(second, 'i18n'), { recursive: true });
    await fs.writeFile(
      path.join(second, 'i18n', 'en.json'),
      JSON.stringify({ title: 'Stats' })
    );

    const messages = await extensionMessageCatalog(
      [
        { id: 'watch-history', directory, messages: 'i18n' },
        { id: 'watch-stats', directory: second, messages: 'i18n' },
      ],
      'en'
    );

    assert.deepStrictEqual(messages, {
      'watch-history.title': 'History',
      'watch-stats.title': 'Stats',
    });

    await fs.rm(second, { recursive: true, force: true });
  });

  it('does not let one broken catalog cost the others their strings', async () => {
    const broken = await fs.mkdtemp(path.join(os.tmpdir(), 'seerr-ext-bad-'));

    await writeCatalog('i18n', 'en', { title: 'History' });
    await fs.mkdir(path.join(broken, 'i18n'), { recursive: true });
    await fs.writeFile(path.join(broken, 'i18n', 'en.json'), '{ not json');

    const messages = await extensionMessageCatalog(
      [
        { id: 'watch-history', directory, messages: 'i18n' },
        { id: 'broken', directory: broken, messages: 'i18n' },
      ],
      'en'
    );

    assert.deepStrictEqual(messages, { 'watch-history.title': 'History' });

    await fs.rm(broken, { recursive: true, force: true });
  });

  it('is empty when no extension ships a catalog', async () => {
    assert.deepStrictEqual(
      await extensionMessageCatalog([{ id: 'demo', directory }], 'en'),
      {}
    );
  });
});
