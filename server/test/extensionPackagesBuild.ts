/**
 * Builds `packages/extension-sdk` and `packages/extension-ui` so tests that
 * compile an example extension can resolve them.
 *
 * The examples' tsconfigs point `@constructorfleet/extension-sdk` and `@constructorfleet/extension-ui`
 * at each package's **`dist/index.d.ts`** — the published shape, which is the
 * whole point: an author consumes the package, not the source tree. But `dist/` is
 * gitignored, so a clean checkout does not have one, and nothing in `pnpm test`
 * used to build it.
 *
 * That made the example tests pass or fail on *file ordering*.
 * `server/test/index.mts` sorts its files, and `sdkPackage.test.ts` /
 * `uiPackage.test.ts` happen to build their package as part of what they assert.
 * So every example test sorting after them got a `dist/` for free, while
 * `removalRequestExtension` sorted before and lost 50 tests to TS2307s out of its
 * `before` hook. Locally the failure hid behind a stale `dist/` left over from an
 * earlier build; in CI it was reproducible.
 *
 * Memoized per process: the runner gives each test file its own process, so this
 * is once per file that asks, and a no-op for the rest of the suite.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.join(__dirname, '../..');
// The repo's own tsc, by path. `npx tsc` from a nested directory can resolve to
// something else entirely.
const TSC = path.join(REPO_ROOT, 'node_modules/typescript/bin/tsc');

/** Roughly 3s locally for both; slower on a cold CI runner. */
const BUILD_TIMEOUT = 120_000;

/**
 * Each package gets the command its own `pnpm build` runs. The UI package is not
 * compiled by `tsc` — its `dist/index.d.ts` is *generated* from core's components
 * by `bin/generateTypes.mjs`.
 */
const BUILDS: { directory: string; args: string[] }[] = [
  {
    directory: 'packages/extension-sdk',
    args: [TSC, '--project', 'tsconfig.json'],
  },
  { directory: 'packages/extension-ui', args: ['bin/generateTypes.mjs'] },
];

let built: Promise<void> | undefined;

export default function buildExtensionPackages(): Promise<void> {
  built ??= (async () => {
    for (const { directory, args } of BUILDS) {
      await execFileAsync(process.execPath, args, {
        cwd: path.join(REPO_ROOT, directory),
        timeout: BUILD_TIMEOUT,
      });
    }
  })();

  return built;
}
