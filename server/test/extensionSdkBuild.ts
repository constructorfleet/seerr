/**
 * Builds `packages/extension-sdk` so tests that compile an example extension can
 * resolve `@seerr/extension-sdk`.
 *
 * Every example's `tsconfig.json` points `@seerr/extension-sdk` at the SDK's
 * **`dist/index.d.ts`** — the published shape, which is the whole point: an
 * author consumes the package, not the source tree. But `dist/` is gitignored, so
 * a clean checkout does not have one, and nothing in `pnpm test` used to build it.
 *
 * That made the example tests pass or fail on *file ordering*.
 * `server/test/index.mts` sorts its files, and `sdkPackage.test.ts` happens to
 * typecheck the SDK with `--project tsconfig.json` — which emits. So every example
 * test sorting after `sdkPackage` (`watchHistory`, `watchStats`) got a `dist/` for
 * free, while `removalRequestExtension` sorted before it and got ~30 TS2307/TS7006
 * errors out of its `before` hook. Locally the failure hid behind a stale `dist/`
 * left over from an earlier `pnpm build`; in CI it was reproducible.
 *
 * Memoized per process: the runner gives each test file its own process, so this
 * is once per file that asks, and a no-op for the rest of the suite.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.join(__dirname, '../..');
const PACKAGE_DIRECTORY = path.join(REPO_ROOT, 'packages/extension-sdk');
// The repo's own tsc, by path. `npx tsc` from a nested directory can resolve to
// something else entirely.
const TSC = path.join(REPO_ROOT, 'node_modules/typescript/bin/tsc');

/** Roughly 2s locally; slower on a cold CI runner. */
const BUILD_TIMEOUT = 120_000;

let built: Promise<void> | undefined;

export default function buildExtensionSdk(): Promise<void> {
  built ??= execFileAsync(
    process.execPath,
    [TSC, '--project', 'tsconfig.json'],
    {
      cwd: PACKAGE_DIRECTORY,
      timeout: BUILD_TIMEOUT,
    }
  ).then(() => undefined);

  return built;
}
