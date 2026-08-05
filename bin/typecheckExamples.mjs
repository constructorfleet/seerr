/**
 * Typechecks every example extension under `examples/`.
 *
 * These are reference material an author copies, so a broken one is worse than
 * no example — and until this script existed, nothing gave a direct signal.
 * `pnpm lint` globs only `server/`, `src/` and `packages/`; the root `tsc`
 * projects exclude `examples/`. The one thing that did compile them was
 * `server/lib/extensions/removalRequestExtension.test.ts`, which shells out to
 * `pnpm build` — a four-minute suite away, and it surfaces a build failure as a
 * confusing error in its own cleanup rather than as tsc output. A bad merge
 * consequently shipped an example that could not compile.
 *
 * Each example has two projects, because an extension is a backend with an
 * optional frontend and the two have incompatible module systems: `tsconfig.json`
 * builds the CommonJS server (the loader `require()`s it), and
 * `tsconfig.panel.json` builds the panel as an ESM bundle. Both are checked; an
 * example without a panel simply has no second file.
 *
 * `--noEmit` throughout: this is a check, not the build. `pnpm build` inside an
 * example is still what produces `dist/`.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const examplesDirectory = path.join(root, 'examples');
// The repo's own tsc, by path. `npx tsc` from a nested directory can resolve to
// something else entirely, and examples are not workspace members so they have
// no `node_modules/.bin` of their own.
const tsc = path.join(root, 'node_modules', '.bin', 'tsc');

const PROJECTS = ['tsconfig.json', 'tsconfig.panel.json'];

/** Example directories, in a stable order so output is diffable. */
async function findExamples() {
  const entries = await fs.readdir(examplesDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

let failed = false;

for (const example of await findExamples()) {
  const directory = path.join(examplesDirectory, example);

  for (const project of PROJECTS) {
    if (!(await exists(path.join(directory, project)))) {
      continue;
    }

    try {
      await run(tsc, ['--project', project, '--noEmit'], { cwd: directory });
      // eslint-disable-next-line no-console
      console.log(`  ✔ ${example}/${project}`);
    } catch (error) {
      failed = true;
      // eslint-disable-next-line no-console
      console.error(`  ✖ ${example}/${project}`);
      // tsc writes diagnostics to stdout, not stderr.
      // eslint-disable-next-line no-console
      console.error(error.stdout || error.stderr || error.message);
    }
  }
}

if (failed) {
  process.exitCode = 1;
}
