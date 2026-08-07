/**
 * Tests for the published `@constructorfleet/extension-sdk` package.
 *
 * The package is a workspace member under `packages/extension-sdk`, deliberately
 * *not* a dependency of the root app: Seerr's own build imports
 * `server/lib/extensions/types.ts` directly, and the package re-declares that
 * contract for extension authors. So these tests treat it as an external
 * artifact — they read its manifest, compile it, and compile its conformance
 * suite — rather than importing from it.
 *
 * Two things are being pinned:
 *
 * 1. **It builds standalone.** `tsc` over `packages/extension-sdk/tsconfig.json`
 *    resolves only that package's own dependencies. A stray `@server/` import
 *    added to `src/` fails here, which is what keeps the published package free
 *    of Seerr internals.
 * 2. **It has not drifted from the host contract.**
 *    `conformance/hostContract.ts` asserts assignability between the two in the
 *    direction that matters, plus `defineExtension`'s narrowing claims. It is a
 *    typecheck, so the only way to run it as a test is to compile it.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import { HOST_API_VERSION } from '@server/lib/extensions/loader';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.join(__dirname, '../../..');
const PACKAGE_DIRECTORY = path.join(REPO_ROOT, 'packages/extension-sdk');
const TSC = path.join(REPO_ROOT, 'node_modules/typescript/bin/tsc');

/**
 * `tsc` is slow enough to be worth a raised timeout, and it is the whole point
 * of these tests, so they cannot be made cheaper by mocking it out. Roughly 2s
 * each locally.
 */
const TYPECHECK_TIMEOUT = 120_000;

async function typecheck(project: string): Promise<void> {
  try {
    await execFileAsync(process.execPath, [TSC, '--project', project], {
      cwd: PACKAGE_DIRECTORY,
    });
  } catch (e) {
    const { stdout, stderr } = e as { stdout?: string; stderr?: string };
    assert.fail(
      `tsc --project ${project} failed:\n${stdout ?? ''}${stderr ?? ''}`
    );
  }
}

async function readPackageJson(): Promise<Record<string, never>> {
  return JSON.parse(
    await fs.readFile(path.join(PACKAGE_DIRECTORY, 'package.json'), 'utf8')
  );
}

describe('@constructorfleet/extension-sdk package', () => {
  it('typechecks standalone', { timeout: TYPECHECK_TIMEOUT }, async () => {
    await typecheck('tsconfig.json');
  });

  it(
    'agrees with the host contract it mirrors',
    { timeout: TYPECHECK_TIMEOUT },
    async () => {
      await typecheck('tsconfig.conformance.json');
    }
  );

  it('is publishable under the name the spec documents', async () => {
    const pkg = await readPackageJson();

    assert.strictEqual(pkg.name, '@constructorfleet/extension-sdk');
    assert.strictEqual(pkg.private, undefined);
  });

  it('versions itself as the host API version extensions declare against', async () => {
    const pkg = await readPackageJson();

    // An extension's manifest `apiVersion` is a range over the *host* API
    // version, and its dependency on this package is a range over the package
    // version. Those two ranges only mean the same thing while the versions
    // agree, so `^1.0.0` in both places is one decision rather than two.
    assert.strictEqual(pkg.version, HOST_API_VERSION);
  });

  it('imports nothing from Seerr at runtime', async () => {
    const sources = await fs.readdir(path.join(PACKAGE_DIRECTORY, 'src'));

    for (const file of sources) {
      const contents = await fs.readFile(
        path.join(PACKAGE_DIRECTORY, 'src', file),
        'utf8'
      );

      assert.doesNotMatch(
        contents,
        /from '@server\//,
        `${file} imports from @server/, which is not resolvable outside this repo`
      );
    }
  });

  it('re-exports every public declaration from its entry point', async () => {
    // `exports` in package.json exposes only `"."`, so a type declared in
    // `src/types.ts` and not re-exported from `src/index.ts` is unreachable for
    // an extension author — there is no permitted deep import to fall back to.
    // `ExtensionMediaWrite` was missed exactly this way, and the failure is a
    // TS2724 in the author's editor with nothing failing here, so the list is
    // checked mechanically rather than by review.
    const modules = [
      'types',
      'manifest',
      'manifestInput',
      'entities',
      'defineExtension',
      'columns',
    ];
    const entry = await fs.readFile(
      path.join(PACKAGE_DIRECTORY, 'src/index.ts'),
      'utf8'
    );
    const missing: string[] = [];

    for (const filename of modules) {
      const source = await fs.readFile(
        path.join(PACKAGE_DIRECTORY, 'src', `${filename}.ts`),
        'utf8'
      );

      for (const [, name] of source.matchAll(
        /^export (?:declare )?(?:type|interface|const|function|class|enum) ([A-Za-z0-9_]+)/gm
      )) {
        if (!new RegExp(`\\b${name}\\b`).test(entry)) {
          missing.push(`${filename}.ts: ${name}`);
        }
      }
    }

    assert.deepStrictEqual(
      missing,
      [],
      `not re-exported from index.ts:\n${missing.join('\n')}`
    );
  });

  it('declares its type-only dependencies as peers, not dependencies', async () => {
    const pkg = await readPackageJson();

    // `express`, `typeorm`, `winston` and `zod` appear only in `import type`
    // positions, and at runtime the extension shares the *host's* copies. A hard
    // dependency would install a second TypeORM whose `Repository` is a
    // different nominal type from the one the SDK actually hands over.
    assert.deepStrictEqual(Object.keys(pkg.dependencies ?? {}), []);

    for (const peer of ['express', 'typeorm', 'winston', 'zod']) {
      assert.ok(
        peer in (pkg.peerDependencies ?? {}),
        `expected "${peer}" to be a peer dependency`
      );
    }
  });
});
