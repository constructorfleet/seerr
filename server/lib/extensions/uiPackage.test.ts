/**
 * Tests for the published `@seerr/extension-ui` package.
 *
 * Its sibling `@seerr/extension-sdk` re-declares the host contract by hand and
 * pins the copy with a conformance typecheck. This package cannot work that way:
 * its surface is 25 components' React prop types, mostly unexported, one of them a
 * generic over `React.ElementType`. So the declarations are *generated* from
 * `src/components/ExtensionUi/index.ts`, and there is no second copy to drift.
 *
 * What can still go wrong is the generation itself, which is what these pin:
 *
 * 1. **It generates at all**, and covers every name the host publishes.
 * 2. **It resolves with no aliases.** An extension is built outside this repo and
 *    has no `@app/*` or `@server/*` paths, so the emitted specifiers are rewritten
 *    to relative ones. A missed rewrite typechecks fine *here* — where the aliases
 *    exist — and fails only for an author, which is the failure worth a test.
 * 3. **It constructs nothing.** A component defined in this package rather than
 *    read off the host global would carry no host CSS, which is the entire failure
 *    the package exists to prevent.
 *
 * The generation shells out to `tsc`, so this is slow (a few seconds) and cannot be
 * made cheaper by faking it — running the real emit is the test.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { promisify } from 'node:util';

import { UI_COMPONENT_NAMES } from '@server/lib/extensions/uiComponents';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.join(__dirname, '../../..');
const PACKAGE_DIRECTORY = path.join(REPO_ROOT, 'packages/extension-ui');
const DIST = path.join(PACKAGE_DIRECTORY, 'dist');
const TSC = path.join(REPO_ROOT, 'node_modules/typescript/bin/tsc');

/** Generation runs the host's whole declaration emit; ~5s locally. */
const BUILD_TIMEOUT = 180_000;

/** Generated once for the whole file rather than per test. */
before(
  async () => {
    await execFileAsync(
      process.execPath,
      [path.join(PACKAGE_DIRECTORY, 'bin/generateTypes.mjs')],
      { cwd: PACKAGE_DIRECTORY }
    );
  },
  { timeout: BUILD_TIMEOUT }
);

/** Every generated `.d.ts`, so the alias check can walk the whole tree. */
async function declarationFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    const full = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      found.push(...(await declarationFiles(full)));
    } else if (entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }

  return found;
}

describe('@seerr/extension-ui package', () => {
  it('generates an entry point exporting the component barrel', async () => {
    const source = await fs.readFile(path.join(DIST, 'index.d.ts'), 'utf8');

    assert.match(source, /export \* from '\.\/src\/components\/ExtensionUi'/);
  });

  it('publishes a type for every component the host shares', async () => {
    const source = await fs.readFile(
      path.join(DIST, 'src/components/ExtensionUi/index.d.ts'),
      'utf8'
    );

    for (const name of UI_COMPONENT_NAMES) {
      assert.match(
        source,
        new RegExp(`\\b${name}\\b`),
        `${name} should be typed`
      );
    }
  });

  it('leaves no @app or @server specifier for a consumer to resolve', async () => {
    // The one failure this repo cannot notice on its own: the aliases resolve
    // *here*, so a missed rewrite typechecks locally and breaks only in an
    // extension author's build, where no such paths exist.
    const offenders: string[] = [];

    for (const file of await declarationFiles(DIST)) {
      const source = await fs.readFile(file, 'utf8');

      if (/(?:from\s+|import\s*\()['"]@(?:app|server)\//.test(source)) {
        offenders.push(path.relative(DIST, file));
      }
    }

    assert.deepEqual(offenders, []);
  });

  it('typechecks with no path mapping, the way an author consumes it', async () => {
    // `--strict` and `skipLibCheck: false`: the point is that the emitted tree is
    // internally complete, which a skipped lib check would hide.
    await execFileAsync(
      process.execPath,
      [
        TSC,
        '--noEmit',
        '--strict',
        '--jsx',
        'react-jsx',
        '--moduleResolution',
        'bundler',
        '--module',
        'ES2022',
        '--target',
        'ES2022',
        path.join(DIST, 'index.d.ts'),
      ],
      { cwd: PACKAGE_DIRECTORY }
    );
  });

  it('reads components off the host global rather than defining any', async () => {
    const runtime = await fs.readFile(path.join(DIST, 'index.js'), 'utf8');

    // A component constructed here would render without host CSS — the exact
    // failure re-exporting the host's own components avoids.
    assert.match(runtime, /__seerr_shared__/);
    assert.doesNotMatch(runtime, /React\.createElement|function [A-Z]/);
  });

  it('declares react a peer dependency rather than bundling it', async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(PACKAGE_DIRECTORY, 'package.json'), 'utf8')
    ) as {
      name: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    assert.equal(manifest.name, '@seerr/extension-ui');
    // A real `react` dependency would install a second copy, and a panel
    // rendering against it fails on its first hook.
    assert.equal(manifest.dependencies, undefined);
    assert.ok(manifest.peerDependencies?.react);
  });
});
