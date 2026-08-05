/**
 * Tests for the SDK's dialect-aware column helper.
 *
 * This closes the one slice-9 finding that shipped documented-but-unfixed: an
 * extension could not portably declare a date column. Core writes dates through
 * `DbAwareColumn`, which rewrites `datetime` to `timestamp with time zone` on
 * Postgres; an extension has no access to that host-internal helper, so a bare
 * `type: 'datetime'` worked on sqlite and failed on someone else's deployment.
 *
 * The behaviour under test is **resolved at decoration time**, which is what
 * makes it awkward to test in-process: `@Column({ type: ... })` runs when the
 * module is first imported, so a single process can only ever observe one
 * dialect. Every case here therefore runs in a **child process** with `DB_TYPE`
 * set, importing the built package fresh. That is the only way to see the
 * decision the helper actually makes rather than the one it made when this test
 * file's imports were evaluated.
 *
 * These tests exercise `dist/`, not `src/`, because that is what an extension
 * installs and `require()`s. A change to `src` without a rebuild fails here,
 * deliberately.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import type { ColumnOptions, ColumnType } from 'typeorm';

const execFileAsync = promisify(execFile);

/**
 * The two exports under test, declared structurally rather than imported.
 *
 * `@seerr/extension-sdk` is deliberately absent from the server tsconfig's
 * `paths`: the host must not be able to import the published mirror of its own
 * contract, or the mirror stops being independently checkable. `ColumnType` is
 * the host's own typeorm type, which is the same package the SDK peer-depends on,
 * so this is a real check on the signature and not `any` in disguise.
 */
interface SdkColumns {
  resolveColumnType: (type: ColumnType) => ColumnType;
  DbAwareColumn: (options: ColumnOptions) => PropertyDecorator;
}

const REPO_ROOT = path.join(__dirname, '../../..');
const PACKAGE_DIRECTORY = path.join(REPO_ROOT, 'packages/extension-sdk');
const TSC = path.join(REPO_ROOT, 'node_modules/typescript/bin/tsc');

/** `tsc` over the package is ~2s; the child-process probes are fast. */
const BUILD_TIMEOUT = 120_000;

/**
 * Evaluates `expression` in a child process with `DB_TYPE` set, against the
 * built package, and returns the JSON-serialized result.
 *
 * `resolveColumnType` returns TypeORM `ColumnType`, which is a string for every
 * case here, so JSON round-tripping loses nothing.
 */
async function inChildProcess(
  dbType: string | undefined,
  expression: string
): Promise<unknown> {
  const script = `
    const sdk = require(${JSON.stringify(path.join(PACKAGE_DIRECTORY, 'dist/index.js'))});
    process.stdout.write(JSON.stringify(${expression}));
  `;

  const env = { ...process.env };

  if (dbType === undefined) {
    delete env.DB_TYPE;
  } else {
    env.DB_TYPE = dbType;
  }

  const { stdout } = await execFileAsync(process.execPath, ['-e', script], {
    env,
  });

  return JSON.parse(stdout);
}

describe('the SDK dialect-aware column helper', () => {
  // The child processes require `dist/`, so it has to reflect `src/`.
  before(
    async () => {
      await execFileAsync(
        process.execPath,
        [TSC, '--project', 'tsconfig.json'],
        {
          cwd: PACKAGE_DIRECTORY,
        }
      );
    },
    { timeout: BUILD_TIMEOUT }
  );

  describe('resolveColumnType', () => {
    it('maps datetime to a timestamptz on postgres', async () => {
      assert.strictEqual(
        await inChildProcess('postgres', "sdk.resolveColumnType('datetime')"),
        'timestamp with time zone'
      );
    });

    it('leaves datetime alone on sqlite', async () => {
      assert.strictEqual(
        await inChildProcess('sqlite', "sdk.resolveColumnType('datetime')"),
        'datetime'
      );
    });

    /**
     * The host treats an unset `DB_TYPE` as sqlite (`isPgsql` is
     * `process.env.DB_TYPE === 'postgres'`), and an extension must agree with it
     * — disagreeing would mean the extension's tables and core's disagree about
     * the dialect within one database.
     */
    it('treats an unset DB_TYPE as sqlite, exactly as the host does', async () => {
      assert.strictEqual(
        await inChildProcess(undefined, "sdk.resolveColumnType('datetime')"),
        'datetime'
      );
    });

    it('passes through a type it has no mapping for', async () => {
      assert.strictEqual(
        await inChildProcess('postgres', "sdk.resolveColumnType('varchar')"),
        'varchar'
      );
    });
  });

  describe('DbAwareColumn', () => {
    /**
     * The decorator is the part an extension actually writes. Asserting on the
     * options TypeORM records proves the rewrite reached the metadata, not just
     * that a helper function returns the right string.
     */
    it('records a timestamptz in the column metadata on postgres', async () => {
      assert.strictEqual(
        await inChildProcess(
          'postgres',
          `(() => {
            const { getMetadataArgsStorage } = require('typeorm');
            class Probe {}
            sdk.DbAwareColumn({ type: 'datetime' })(Probe.prototype, 'at');
            return getMetadataArgsStorage().columns.at(-1).options.type;
          })()`
        ),
        'timestamp with time zone'
      );
    });

    it('records a datetime in the column metadata on sqlite', async () => {
      assert.strictEqual(
        await inChildProcess(
          'sqlite',
          `(() => {
            const { getMetadataArgsStorage } = require('typeorm');
            class Probe {}
            sdk.DbAwareColumn({ type: 'datetime' })(Probe.prototype, 'at');
            return getMetadataArgsStorage().columns.at(-1).options.type;
          })()`
        ),
        'datetime'
      );
    });

    /**
     * Options other than `type` have to survive: the common declaration is
     * `{ type: 'datetime', nullable: true }` or one carrying a default, and
     * silently dropping those would be worse than the bug this fixes.
     */
    it('preserves the other column options it was given', async () => {
      assert.deepStrictEqual(
        await inChildProcess(
          'postgres',
          `(() => {
            const { getMetadataArgsStorage } = require('typeorm');
            class Probe {}
            sdk.DbAwareColumn({ type: 'datetime', nullable: true, comment: 'x' })(
              Probe.prototype,
              'at'
            );
            const { type, nullable, comment } =
              getMetadataArgsStorage().columns.at(-1).options;
            return { type, nullable, comment };
          })()`
        ),
        {
          type: 'timestamp with time zone',
          nullable: true,
          comment: 'x',
        }
      );
    });

    /**
     * The caller's object must not be mutated. Core's `DbAwareColumn` assigns
     * back into its argument, which is harmless there because every call site
     * passes a fresh literal — but an extension sharing one options object
     * across columns would otherwise see the first call rewrite it for all of
     * them.
     */
    it('does not mutate the options object it was passed', async () => {
      assert.strictEqual(
        await inChildProcess(
          'postgres',
          `(() => {
            const options = { type: 'datetime' };
            class Probe {}
            sdk.DbAwareColumn(options)(Probe.prototype, 'at');
            return options.type;
          })()`
        ),
        'datetime'
      );
    });
  });

  /**
   * The agreement that actually matters, and the reason this test file lives in
   * the host repo rather than in the package.
   *
   * The SDK duplicates core's mapping instead of importing it — it cannot import
   * `@server/*` and still be publishable. So the two copies can drift, and the
   * consequence would be an extension's tables disagreeing with core's about the
   * dialect *within the same database*. Comparing them directly is the only check
   * that catches a new entry added to one `pgTypeMapping` and not the other.
   *
   * This runs in-process, so it only ever observes the dialect this test run was
   * started under — which is fine, because what is being compared is the two
   * implementations' answers to the same question, not the answer itself.
   */
  it('resolves types identically to the host helper it mirrors', async () => {
    const { resolveDbType } = await import('@server/utils/DbColumnHelper');
    // The package's emit is CommonJS, and it is loaded from `dist/` here exactly
    // as an installed extension would load it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require(
      path.join(PACKAGE_DIRECTORY, 'dist/index.js')
    ) as SdkColumns;

    // `datetime` is the mapped case; the rest are a spot-check that neither side
    // rewrites something the other leaves alone.
    for (const type of [
      'datetime',
      'varchar',
      'integer',
      'bigint',
      'text',
      'boolean',
    ] as const) {
      assert.strictEqual(
        sdk.resolveColumnType(type),
        resolveDbType(type),
        `the SDK and the host disagree about "${type}"`
      );
    }
  });

  /**
   * The helper is the package's first runtime code beyond `defineExtension`, and
   * the property worth pinning is that it decides the dialect the same way the
   * host does — from the environment.
   *
   * Asserted on the module's *imports* rather than by grepping its text for
   * "DataSource": the explanation of why a DataSource cannot be consulted here
   * is itself part of the file, so a text search flags the comment that documents
   * the correct behaviour. Only `typeorm` may be imported, and only for `Column`
   * plus types.
   */
  it('reads the dialect from the environment, as the host does', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(PACKAGE_DIRECTORY, 'src/columns.ts'), 'utf8')
    );

    assert.match(source, /process\.env\.DB_TYPE === 'postgres'/);

    const imported = [...source.matchAll(/^import .*? from '(.+?)';$/gm)].map(
      (match) => match[1]
    );

    assert.deepStrictEqual([...new Set(imported)], ['typeorm']);
  });
});
