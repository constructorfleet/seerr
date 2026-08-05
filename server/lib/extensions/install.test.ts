/**
 * Tests for installing and uninstalling extensions.
 *
 * No network access anywhere. The fetch step is injected — `installExtension`
 * takes a `fetch` that receives a staging directory and populates it, and these
 * tests pass one that copies from a local fixture. The two real fetchers
 * (`npmFetcher`, `gitFetcher`) are tested for the *command* they would run,
 * because that is the part worth pinning and the part that does not need a
 * registry to check.
 *
 * On-disk fixtures follow `loader.test.ts`: a tmpdir per test, extensions written
 * as plain CommonJS.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { promisify } from 'node:util';

import dataSource, { getRepository } from '@server/datasource';
import { ExtensionKv } from '@server/entity/ExtensionKv';
import { ExtensionNotificationSubscription } from '@server/entity/ExtensionNotificationSubscription';
import { ExtensionPermission } from '@server/entity/ExtensionPermission';
import {
  ExtensionInstallError,
  MANIFEST_FILENAME,
  gitFetchCommand,
  installExtension,
  npmFetchCommand,
  npmFetcher,
  sourceKind,
  uninstallExtension,
} from '@server/lib/extensions/install';
import { HOST_API_VERSION } from '@server/lib/extensions/loader';
import { setupTestDb } from '@server/test/db';

setupTestDb();

const execFileAsync = promisify(execFile);

let root: string;
/** Where installs land, standing in for `extensionsDirectory()`. */
let directory: string;
/** Where fixture packages are built, standing in for a registry or a git remote. */
let source: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'seerr-ext-install-'));
  directory = path.join(root, 'extensions');
  source = path.join(root, 'source');
  await fs.mkdir(source, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

interface PackageOptions {
  /** Overrides merged into the manifest. `null` omits the manifest entirely. */
  manifest?: Record<string, unknown> | null;
  /** Written verbatim as the manifest, for unparseable JSON. */
  rawManifest?: string;
  /** Source of the entry point. `null` omits the file. */
  server?: string | null;
  /** Extra files, keyed by path relative to the package root. */
  files?: Record<string, string>;
}

/**
 * Builds a fixture package on disk and returns its path. Stands in for whatever
 * `npm pack` or `git clone` would have produced.
 */
async function writePackage(
  name: string,
  options: PackageOptions = {}
): Promise<string> {
  const packageDirectory = path.join(source, name);
  await fs.mkdir(packageDirectory, { recursive: true });

  if (options.rawManifest !== undefined) {
    await fs.writeFile(
      path.join(packageDirectory, MANIFEST_FILENAME),
      options.rawManifest
    );
  } else if (options.manifest !== null) {
    await fs.writeFile(
      path.join(packageDirectory, MANIFEST_FILENAME),
      JSON.stringify({
        id: name,
        name: `Extension ${name}`,
        version: '1.0.0',
        apiVersion: '^1.0.0',
        server: 'server.js',
        ...options.manifest,
      })
    );
  }

  if (options.server !== null) {
    await fs.writeFile(
      path.join(packageDirectory, 'server.js'),
      options.server ?? 'module.exports.default = () => {};'
    );
  }

  for (const [file, contents] of Object.entries(options.files ?? {})) {
    const target = path.join(packageDirectory, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }

  return packageDirectory;
}

/** A `fetch` that copies a prepared fixture into the staging directory. */
function fetchFrom(packageDirectory: string) {
  return async (staging: string) => {
    await fs.cp(packageDirectory, staging, { recursive: true });
  };
}

function install(packageDirectory: string, source = 'fixture') {
  return installExtension({
    source,
    directory,
    fetch: fetchFrom(packageDirectory),
  });
}

/** Directory names under the install root, or none if it does not exist. */
async function installed(): Promise<string[]> {
  try {
    return (await fs.readdir(directory)).sort();
  } catch {
    return [];
  }
}

describe('installExtension', () => {
  it('installs a valid extension into <directory>/<id>/', async () => {
    const result = await install(await writePackage('demo'));

    assert.strictEqual(result.id, 'demo');
    assert.strictEqual(result.directory, path.join(directory, 'demo'));
    assert.strictEqual(result.manifest.name, 'Extension demo');
    assert.deepStrictEqual(await installed(), ['demo']);
  });

  it('creates the extensions directory when it does not exist yet', async () => {
    assert.deepStrictEqual(await installed(), []);

    await install(await writePackage('demo'));

    assert.deepStrictEqual(await installed(), ['demo']);
  });

  it('copies the package contents, not just the manifest', async () => {
    await install(
      await writePackage('demo', {
        files: { 'dist/panel.js': 'export default () => null;' },
      })
    );

    const panel = await fs.readFile(
      path.join(directory, 'demo', 'dist/panel.js'),
      'utf8'
    );
    assert.strictEqual(panel, 'export default () => null;');
  });

  it('reports the version it installed', async () => {
    const result = await install(
      await writePackage('demo', { manifest: { version: '2.4.6' } })
    );

    assert.strictEqual(result.manifest.version, '2.4.6');
  });

  it('leaves no staging directory behind', async () => {
    await install(await writePackage('demo'));

    // Staging is a sibling of the install target, so a leftover would show up
    // as a directory discovery then has to ignore.
    assert.deepStrictEqual(await installed(), ['demo']);
  });
});

describe('installExtension validation', () => {
  it('rejects a package with no manifest', async () => {
    const pkg = await writePackage('demo', { manifest: null });

    await assert.rejects(
      () => install(pkg),
      (e: Error) => {
        assert.ok(e instanceof ExtensionInstallError);
        assert.match(e.message, new RegExp(MANIFEST_FILENAME));
        return true;
      }
    );
  });

  it('leaves no directory behind when the manifest is missing', async () => {
    const pkg = await writePackage('demo', { manifest: null });

    await assert.rejects(() => install(pkg));

    assert.deepStrictEqual(await installed(), []);
  });

  it('rejects a manifest that is not valid JSON', async () => {
    const pkg = await writePackage('demo', { rawManifest: '{ "id": ' });

    await assert.rejects(
      () => install(pkg),
      (e: Error) => {
        assert.ok(e instanceof ExtensionInstallError);
        assert.match(e.message, /JSON/i);
        return true;
      }
    );

    assert.deepStrictEqual(await installed(), []);
  });

  it('rejects a manifest that fails schema validation', async () => {
    const pkg = await writePackage('demo', { manifest: { name: '' } });

    await assert.rejects(
      () => install(pkg),
      (e: Error) => {
        assert.ok(e instanceof ExtensionInstallError);
        assert.match(e.message, /manifest/i);
        return true;
      }
    );

    assert.deepStrictEqual(await installed(), []);
  });

  it('rejects an apiVersion the host does not satisfy, legibly', async () => {
    const pkg = await writePackage('demo', {
      manifest: { apiVersion: '^2.0.0' },
    });

    await assert.rejects(
      () => install(pkg),
      (e: Error) => {
        assert.ok(e instanceof ExtensionInstallError);
        // Both halves of the mismatch, so an operator can see which side to fix.
        assert.match(e.message, /\^2\.0\.0/);
        assert.match(e.message, new RegExp(HOST_API_VERSION));
        return true;
      }
    );

    assert.deepStrictEqual(await installed(), []);
  });

  it('accepts an apiVersion range the host does satisfy', async () => {
    await install(
      await writePackage('demo', { manifest: { apiVersion: '>=1.0.0 <2' } })
    );

    assert.deepStrictEqual(await installed(), ['demo']);
  });

  it('rejects a package whose entry point does not exist', async () => {
    const pkg = await writePackage('demo', { server: null });

    await assert.rejects(
      () => install(pkg),
      (e: Error) => {
        assert.ok(e instanceof ExtensionInstallError);
        assert.match(e.message, /server\.js/);
        return true;
      }
    );

    assert.deepStrictEqual(await installed(), []);
  });

  it('rejects a manifest id that disagrees with the npm package name', async () => {
    // The directory an extension lands in is its manifest `id`, and discovery
    // refuses a directory whose name is not the id. Installing `some-package`
    // whose manifest says `id: "other"` would therefore install something the
    // operator did not ask for under a name they did not type.
    const packageDirectory = await writePackage('demo', {
      manifest: { id: 'something-else' },
    });

    await assert.rejects(
      () =>
        installExtension({
          source: 'demo',
          directory,
          expectedId: 'demo',
          fetch: fetchFrom(packageDirectory),
        }),
      (e: Error) => {
        assert.ok(e instanceof ExtensionInstallError);
        assert.match(e.message, /something-else/);
        assert.match(e.message, /demo/);
        return true;
      }
    );

    assert.deepStrictEqual(await installed(), []);
  });

  it('accepts a manifest id that matches the expected id', async () => {
    await installExtension({
      source: 'demo',
      directory,
      expectedId: 'demo',
      fetch: fetchFrom(await writePackage('demo')),
    });

    assert.deepStrictEqual(await installed(), ['demo']);
  });

  it('reports a failing fetch as an install error', async () => {
    await assert.rejects(
      () =>
        installExtension({
          source: 'nope',
          directory,
          fetch: async () => {
            throw new Error('registry unreachable');
          },
        }),
      (e: Error) => {
        assert.ok(e instanceof ExtensionInstallError);
        assert.match(e.message, /registry unreachable/);
        return true;
      }
    );

    assert.deepStrictEqual(await installed(), []);
  });

  it('does not disturb an already-installed extension when a new install fails', async () => {
    await install(await writePackage('good'));
    const bad = await writePackage('bad', { rawManifest: 'nope' });

    await assert.rejects(() => install(bad));

    assert.deepStrictEqual(await installed(), ['good']);
    // And the survivor is still intact, not merely present.
    const manifest = JSON.parse(
      await fs.readFile(path.join(directory, 'good', MANIFEST_FILENAME), 'utf8')
    );
    assert.strictEqual(manifest.id, 'good');
  });
});

describe('installExtension reinstall', () => {
  it('replaces an existing install of the same id', async () => {
    await install(
      await writePackage('demo', { manifest: { version: '1.0.0' } })
    );

    await fs.rm(path.join(source, 'demo'), { recursive: true });
    const result = await install(
      await writePackage('demo', { manifest: { version: '2.0.0' } })
    );

    assert.strictEqual(result.manifest.version, '2.0.0');
    assert.strictEqual(result.replaced, true);
  });

  it('reports a first install as not replacing anything', async () => {
    const result = await install(await writePackage('demo'));

    assert.strictEqual(result.replaced, false);
  });

  it('does not leave stale files from the previous version behind', async () => {
    await install(
      await writePackage('demo', { files: { 'dist/gone.js': 'old' } })
    );
    await fs.rm(path.join(source, 'demo'), { recursive: true });
    await install(await writePackage('demo'));

    await assert.rejects(() =>
      fs.access(path.join(directory, 'demo', 'dist/gone.js'))
    );
  });

  it('keeps the old version in place when the new one is invalid', async () => {
    await install(
      await writePackage('demo', { manifest: { version: '1.0.0' } })
    );
    await fs.rm(path.join(source, 'demo'), { recursive: true });
    const upgrade = await writePackage('demo', {
      manifest: { apiVersion: '^9.0.0' },
    });

    await assert.rejects(() => install(upgrade));

    const manifest = JSON.parse(
      await fs.readFile(path.join(directory, 'demo', MANIFEST_FILENAME), 'utf8')
    );
    assert.strictEqual(manifest.version, '1.0.0');
  });
});

describe('npmFetchCommand', () => {
  it("installs into the staging prefix, never Seerr's node_modules", () => {
    const { command, args, cwd } = npmFetchCommand('watch-history', '/staging');

    assert.strictEqual(command, 'npm');
    assert.strictEqual(cwd, '/staging');
    assert.ok(args.includes('install'));
    assert.ok(args.includes('watch-history'));
  });

  it('runs no lifecycle scripts', () => {
    const { args } = npmFetchCommand('watch-history', '/staging');

    // An extension is trusted code once loaded, but a `postinstall` runs before
    // the operator has seen its manifest — before this install has decided to
    // accept it at all.
    assert.ok(args.includes('--ignore-scripts'));
  });

  it('omits dev dependencies and the lockfile', () => {
    const { args } = npmFetchCommand('watch-history', '/staging');

    assert.ok(args.includes('--omit=dev'));
    assert.ok(args.includes('--no-package-lock'));
  });

  it('passes a versioned spec through untouched', () => {
    const { args } = npmFetchCommand('watch-history@2.1.0', '/staging');

    assert.ok(args.includes('watch-history@2.1.0'));
  });

  it('refuses a spec that looks like a flag', () => {
    // `args` is passed to `execFile` without a shell, so there is no injection
    // to worry about — but a leading `-` would be read by npm as an option.
    assert.throws(
      () => npmFetchCommand('--registry=http://evil', '/staging'),
      ExtensionInstallError
    );
  });

  it('accepts the package-name shapes npm publishes', () => {
    for (const spec of [
      'watch-history',
      'watch-history@2.1.0',
      'watch-history@latest',
      'watch-history@^2.0.0',
      '@seerr/history',
      '@seerr/history@1.2.3',
      'Legacy-MixedCase',
      // How an offline install arrives: `npm pack` output installed by path.
      '/tmp/tarballs/demo-1.0.0.tgz',
      './demo-1.0.0.tar.gz',
    ]) {
      assert.doesNotThrow(
        () => npmFetchCommand(spec, '/staging'),
        `expected "${spec}" to be accepted`
      );
    }
  });

  /**
   * `gitFetchCommand` refuses these, but it never sees them: `sourceKind` reads
   * anything that is not a git remote as an npm spec, and npm accepts `file:`
   * specifiers, bare paths and its own `github:`/`npm:` shorthands as package
   * sources. The refusal has to live on this side too or it does not exist.
   */
  it('refuses a location masquerading as a package name', () => {
    for (const spec of [
      'file:///etc/passwd',
      'file:../../../etc',
      '/Users/someone/secret',
      './local',
      '../local',
      'ext::sh -c whoami',
      // npm's own shorthands reach a remote of npm's choosing, bypassing the
      // scheme allowlist that `gitFetchCommand` applies.
      'github:owner/repo',
      'gitlab:owner/repo',
      'bitbucket:owner/repo',
      'gist:abc123',
      'npm:other-package@1.0.0',
      // A local `.tgz` is allowed, but the extension must not become a second
      // way to fetch over the network: that stays on the git path, behind its
      // scheme allowlist.
      'https://evil.host/pkg.tgz',
      'file:///etc/x.tgz',
    ]) {
      assert.throws(
        () => npmFetchCommand(spec, '/staging'),
        ExtensionInstallError,
        `expected "${spec}" to be refused`
      );
    }
  });
});

describe('gitFetchCommand', () => {
  it('clones into the staging directory', () => {
    const { command, args } = gitFetchCommand(
      'https://github.com/o/r.git',
      '/staging'
    );

    assert.strictEqual(command, 'git');
    assert.ok(args.includes('clone'));
    assert.ok(args.includes('https://github.com/o/r.git'));
  });

  it('clones shallowly', () => {
    const { args } = gitFetchCommand('https://github.com/o/r.git', '/staging');

    assert.ok(args.includes('--depth'));
    assert.ok(args.includes('1'));
  });

  it('accepts a #ref suffix as the branch to clone', () => {
    const { args } = gitFetchCommand(
      'https://github.com/o/r.git#v2',
      '/staging'
    );

    assert.ok(args.includes('--branch'));
    assert.ok(args.includes('v2'));
    assert.ok(args.includes('https://github.com/o/r.git'));
    assert.ok(!args.some((arg) => arg.includes('#')));
  });

  it('refuses a URL whose scheme is not http(s), ssh or git', () => {
    // `file://` and a bare local path would let an install read anywhere the
    // Seerr process can, which is not what "install from a git repo" means.
    for (const url of ['file:///etc', 'ext::sh -c cat', '/local/path']) {
      assert.throws(
        () => gitFetchCommand(url, '/staging'),
        ExtensionInstallError,
        `expected "${url}" to be refused`
      );
    }
  });

  it('accepts the schemes a git remote legitimately uses', () => {
    for (const url of [
      'https://github.com/o/r.git',
      'http://host/o/r.git',
      'ssh://git@github.com/o/r.git',
      'git://host/o/r.git',
      'git@github.com:o/r.git',
    ]) {
      assert.doesNotThrow(
        () => gitFetchCommand(url, '/staging'),
        `expected "${url}" to be accepted`
      );
    }
  });
});

describe('sourceKind', () => {
  it('reads bare, versioned and scoped package names as npm specs', () => {
    for (const spec of [
      'watch-history',
      'watch-history@2.1.0',
      '@seerr/history',
      '@seerr/history@1.2.3',
    ]) {
      assert.strictEqual(sourceKind(spec), 'npm', `misread "${spec}"`);
    }
  });

  it('reads git remotes as git sources', () => {
    for (const url of [
      'https://github.com/o/r.git',
      // GitHub and GitLab both serve clones from the plain web URL, which is
      // what an operator copies out of the address bar.
      'https://github.com/o/r',
      'ssh://git@github.com/o/r.git',
      'git://host/o/r.git',
      'git@github.com:o/r.git',
      'https://github.com/o/r.git#v2',
    ]) {
      assert.strictEqual(sourceKind(url), 'git', `misread "${url}"`);
    }
  });
});

describe('npmFetcher', () => {
  /**
   * The only end-to-end fetch test here, and the reason it can exist without a
   * network: `npm pack` makes a tarball on disk, and installing a tarball by path
   * needs no registry. The git fetcher has no equivalent, because a local remote
   * would have to be a `file://` URL and `gitFetchCommand` refuses those on
   * purpose — so git is covered by its command shape alone.
   */
  it('installs a local tarball and returns its package root', async () => {
    const packed = await packFixture('demo');

    const result = await installExtension({
      source: packed,
      directory,
      fetch: npmFetcher(packed),
    });

    assert.strictEqual(result.id, 'demo');
    assert.deepStrictEqual(await installed(), ['demo']);
    // npm's own metadata must not come along: the extension directory is what
    // discovery reads, and `package.json` is the extension's, not the staging
    // wrapper's.
    const pkg = JSON.parse(
      await fs.readFile(path.join(directory, 'demo', 'package.json'), 'utf8')
    );
    assert.strictEqual(pkg.name, 'demo');
  });

  it('rejects a tarball whose manifest does not validate', async () => {
    const packed = await packFixture('demo', { apiVersion: '^99.0.0' });

    await assert.rejects(
      () =>
        installExtension({
          source: packed,
          directory,
          fetch: npmFetcher(packed),
        }),
      ExtensionInstallError
    );

    assert.deepStrictEqual(await installed(), []);
  });

  /** Builds a package fixture and `npm pack`s it, returning the tarball path. */
  async function packFixture(
    name: string,
    manifest: Record<string, unknown> = {}
  ): Promise<string> {
    const packageDirectory = await writePackage(name, { manifest });
    await fs.writeFile(
      path.join(packageDirectory, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', main: 'server.js' })
    );

    const tarballs = path.join(root, 'tarballs');
    await fs.mkdir(tarballs, { recursive: true });
    await execFileAsync(
      'npm',
      ['pack', packageDirectory, '--pack-destination', tarballs, '--silent'],
      { cwd: tarballs }
    );

    const [tarball] = await fs.readdir(tarballs);
    return path.join(tarballs, tarball);
  }
});

describe('uninstallExtension', () => {
  /** Rows an extension accumulates, to assert on what uninstall keeps. */
  async function seedExtensionData(extensionId: string): Promise<void> {
    await getRepository(ExtensionPermission).save(
      new ExtensionPermission({ userId: 1, permission: `${extensionId}:view` })
    );
    await getRepository(ExtensionNotificationSubscription).save(
      new ExtensionNotificationSubscription({
        userId: 1,
        notificationType: `${extensionId}:done`,
        agents: [],
      })
    );
    await getRepository(ExtensionKv).save(
      new ExtensionKv({ extensionId, key: 'cursor', value: 42 })
    );
  }

  function uninstall(id: string, options: { purgeData?: boolean } = {}) {
    return uninstallExtension({ id, directory, ...options });
  }

  it('removes the extension directory', async () => {
    await install(await writePackage('demo'));

    const result = await uninstall('demo');

    assert.strictEqual(result.removed, true);
    assert.deepStrictEqual(await installed(), []);
  });

  it('leaves other extensions alone', async () => {
    await install(await writePackage('demo'));
    await install(await writePackage('other'));

    await uninstall('demo');

    assert.deepStrictEqual(await installed(), ['other']);
  });

  it('reports an extension that was not installed', async () => {
    const result = await uninstall('absent');

    assert.strictEqual(result.removed, false);
  });

  it('refuses an id that is not a valid extension id', async () => {
    // `id` is joined onto the extensions directory, so a traversal here would
    // delete an arbitrary directory. The pattern is the only guard.
    for (const id of ['..', '../../etc', 'has_underscore', '']) {
      await assert.rejects(
        () => uninstall(id),
        ExtensionInstallError,
        `expected "${id}" to be refused`
      );
    }
  });

  // The retention decision, and the reason for it. Slice 4 made a *quarantined*
  // extension's permissions unenforceable while leaving its rows on disk, so
  // that reinstalling restores the operator's grants. Uninstall keeps that
  // property by default: string-keyed permissions are stable across
  // install/uninstall precisely so this is possible, and silently discarding a
  // per-user grant set that an operator curated is not recoverable.
  describe('data retention (default)', () => {
    it('keeps ext_permission rows, so a reinstall restores grants', async () => {
      await install(await writePackage('demo'));
      await seedExtensionData('demo');

      await uninstall('demo');

      const rows = await getRepository(ExtensionPermission).find({
        where: { permission: 'demo:view' },
      });
      assert.strictEqual(rows.length, 1);
    });

    it('keeps ext_notification_subscription rows', async () => {
      await install(await writePackage('demo'));
      await seedExtensionData('demo');

      await uninstall('demo');

      const rows = await getRepository(ExtensionNotificationSubscription).find({
        where: { notificationType: 'demo:done' },
      });
      assert.strictEqual(rows.length, 1);
    });

    it('drops the extension-owned ext_<id>_* tables', async () => {
      // These are the one thing that cannot be kept: the entity classes that
      // gave them meaning leave with the directory, and a stale table would
      // collide with a differently-shaped one after a reinstall of a new major
      // version. The spec calls for dropping them.
      await createExtensionTable('demo');
      await install(await writePackage('demo'));

      await uninstall('demo');

      assert.strictEqual(await tableExists('ext_demo_events'), false);
    });

    it('drops the extension migration tracking table', async () => {
      await createExtensionTable('demo', 'ext_demo_migration');
      await install(await writePackage('demo'));

      await uninstall('demo');

      assert.strictEqual(await tableExists('ext_demo_migration'), false);
    });

    it('drops the extension kv rows, which are its storage not its config', async () => {
      // `ext_kv` is a *shared* table, so its rows cannot be dropped with a
      // table — but they are the same kind of thing as an `ext_<id>_*` table:
      // the extension's own state, meaningless without its code.
      await install(await writePackage('demo'));
      await seedExtensionData('demo');

      await uninstall('demo');

      const rows = await getRepository(ExtensionKv).find({
        where: { extensionId: 'demo' },
      });
      assert.deepStrictEqual(rows, []);
    });

    it("leaves another extension's tables and rows untouched", async () => {
      await createExtensionTable('demo');
      await createExtensionTable('other');
      await install(await writePackage('demo'));
      await seedExtensionData('other');

      await uninstall('demo');

      assert.strictEqual(await tableExists('ext_other_events'), true);
      const rows = await getRepository(ExtensionKv).find({
        where: { extensionId: 'other' },
      });
      assert.strictEqual(rows.length, 1);
    });

    it("does not drop a core table that shares the prefix's shape", async () => {
      await install(await writePackage('demo'));

      await uninstall('demo');

      // The core extension tables are named `ext_permission`, `ext_kv`,
      // `ext_notification_subscription` — all of which start with `ext_` and
      // none of which start with `ext_demo_`.
      assert.strictEqual(await tableExists('ext_permission'), true);
      assert.strictEqual(await tableExists('ext_kv'), true);
      assert.strictEqual(
        await tableExists('ext_notification_subscription'),
        true
      );
    });

    it('reports what it dropped', async () => {
      await createExtensionTable('demo');
      await install(await writePackage('demo'));

      const result = await uninstall('demo');

      assert.deepStrictEqual(result.droppedTables, ['ext_demo_events']);
    });
  });

  describe('data retention (purgeData)', () => {
    it('removes ext_permission rows when asked to purge', async () => {
      await install(await writePackage('demo'));
      await seedExtensionData('demo');

      await uninstall('demo', { purgeData: true });

      const rows = await getRepository(ExtensionPermission).find({
        where: { permission: 'demo:view' },
      });
      assert.deepStrictEqual(rows, []);
    });

    it('removes ext_notification_subscription rows when asked to purge', async () => {
      await install(await writePackage('demo'));
      await seedExtensionData('demo');

      await uninstall('demo', { purgeData: true });

      const rows = await getRepository(ExtensionNotificationSubscription).find({
        where: { notificationType: 'demo:done' },
      });
      assert.deepStrictEqual(rows, []);
    });

    it("leaves another extension's rows alone when purging", async () => {
      await install(await writePackage('demo'));
      await seedExtensionData('demo');
      await seedExtensionData('other');

      await uninstall('demo', { purgeData: true });

      const rows = await getRepository(ExtensionPermission).find({
        where: { permission: 'other:view' },
      });
      assert.strictEqual(rows.length, 1);
    });

    it('reports the rows it purged', async () => {
      await install(await writePackage('demo'));
      await seedExtensionData('demo');

      const result = await uninstall('demo', { purgeData: true });

      assert.strictEqual(result.purgedPermissions, 1);
      assert.strictEqual(result.purgedSubscriptions, 1);
    });
  });
});

/** Creates a table in the extension's namespace, as its migration would. */
async function createExtensionTable(
  extensionId: string,
  name = `ext_${extensionId}_events`
): Promise<void> {
  await dataSource.query(
    `CREATE TABLE "${name}" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL)`
  );
}

async function tableExists(name: string): Promise<boolean> {
  const queryRunner = dataSource.createQueryRunner();

  try {
    return await queryRunner.hasTable(name);
  } finally {
    await queryRunner.release();
  }
}
