import dataSource from '@server/datasource';
import logger from '@server/logger';
import type { DataSourceOptions, MixedList, QueryRunner } from 'typeorm';
import { DataSource, MigrationExecutor } from 'typeorm';

/** Every table an extension owns is named `ext_<id>_<something>`. */
export function extensionTablePrefix(extensionId: string): string {
  return `ext_${extensionId}_`;
}

/**
 * Extension migrations are tracked in their own table so core's `migrations`
 * table stays exactly as core's own migration history left it.
 */
export function extensionMigrationsTableName(extensionId: string): string {
  return `${extensionTablePrefix(extensionId)}migration`;
}

export interface ExtensionMigrationSet {
  id: string;
  migrations: MixedList<new () => unknown>;
}

export interface ExtensionMigrationResult {
  id: string;
  /** Names of the migrations applied by this run, in the order applied. */
  migrations: string[];
  /** Set when the extension's migrations failed; the extension is quarantined. */
  error?: Error;
}

export interface RunExtensionMigrationsOptions {
  /**
   * Connection options for the database the extension tables live in. Defaults
   * to the main DataSource's, which is what production wants — extension tables
   * are namespaced inside the core database, not in a database of their own.
   */
  baseOptions?: DataSourceOptions;
}

const SQLITE_TYPES = new Set(['sqlite', 'better-sqlite3', 'expo', 'capacitor']);

/**
 * Runs each extension's pending migrations against the main database, one
 * extension at a time.
 *
 * Sequential rather than concurrent on purpose: sqlite serializes writers, so
 * running these in parallel buys nothing and turns a slow migration into
 * `SQLITE_BUSY` for its neighbours.
 *
 * A failing extension is reported in its result rather than thrown, because a
 * bad extension must not stop Seerr from booting.
 */
export async function runExtensionMigrations(
  extensions: ExtensionMigrationSet[],
  options: RunExtensionMigrationsOptions = {}
): Promise<ExtensionMigrationResult[]> {
  const results: ExtensionMigrationResult[] = [];

  for (const extension of extensions) {
    results.push(await runOne(extension, options));
  }

  return results;
}

async function runOne(
  extension: ExtensionMigrationSet,
  options: RunExtensionMigrationsOptions
): Promise<ExtensionMigrationResult> {
  const migrations = toArray(extension.migrations);

  if (migrations.length === 0) {
    return { id: extension.id, migrations: [] };
  }

  const baseOptions = options.baseOptions ?? defaultBaseOptions();
  const extensionDataSource = new DataSource({
    ...baseOptions,
    // A short-lived DataSource whose only job is to run these migrations: no
    // entities, no subscribers, and nothing auto-run on initialize.
    entities: [],
    subscribers: [],
    synchronize: false,
    dropSchema: false,
    migrationsRun: false,
    migrations,
    migrationsTableName: extensionMigrationsTableName(extension.id),
  } as DataSourceOptions);

  try {
    await extensionDataSource.initialize();
  } catch (e) {
    logger.error('Failed to connect for extension migrations', {
      label: 'Extensions',
      extensionId: extension.id,
      errorMessage: e.message,
    });
    return { id: extension.id, migrations: [], error: asError(e) };
  }

  const queryRunner = extensionDataSource.createQueryRunner();

  try {
    if (SQLITE_TYPES.has(baseOptions.type)) {
      // Same treatment core migrations get in server/index.ts: sqlite
      // rewrites a table by copying it into a `temporary_*` clone, which
      // trips foreign keys mid-rewrite. Must be set before the migration
      // executor opens its transaction — sqlite ignores the pragma inside one.
      await queryRunner.query('PRAGMA foreign_keys=OFF');
    }

    enforceTablePrefix(queryRunner, extension.id);

    const executor = new MigrationExecutor(extensionDataSource, queryRunner);
    const applied = await executor.executePendingMigrations();

    if (applied.length) {
      logger.info(`Applied ${applied.length} extension migration(s)`, {
        label: 'Extensions',
        extensionId: extension.id,
      });
    }

    return {
      id: extension.id,
      migrations: applied.map((migration) => migration.name),
    };
  } catch (e) {
    logger.error('Extension migrations failed', {
      label: 'Extensions',
      extensionId: extension.id,
      errorMessage: e.message,
    });
    return { id: extension.id, migrations: [], error: asError(e) };
  } finally {
    await queryRunner.release().catch(() => undefined);
    await extensionDataSource.destroy().catch(() => undefined);
  }
}

/**
 * Rejects DDL naming a table the extension does not own, by inspecting the SQL
 * on its way to the driver.
 *
 * BEST EFFORT, NOT A SANDBOX. Extension code is trusted code (see
 * docs/specs/extension-system.md, "Trust model"): it is `require()`d into this
 * process and can reach the main DataSource directly, so nothing here stops a
 * determined extension. What it does do is catch the realistic mistake — an
 * extension author writing a migration with an un-prefixed table name — before
 * it lands in the operator's core schema. Known gaps: string inspection cannot
 * see through `DROP INDEX` (index names carry no table), dynamic SQL built at
 * runtime, or a `;` inside a string literal that confuses statement splitting.
 */
function enforceTablePrefix(queryRunner: QueryRunner, extensionId: string) {
  const prefix = extensionTablePrefix(extensionId);
  const query = queryRunner.query.bind(queryRunner);

  // Patched on the instance rather than wrapped in a Proxy so that the
  // higher-level QueryRunner helpers (createTable, addColumn, …) route their
  // generated SQL through this too.
  queryRunner.query = (async (sql: string, ...rest: unknown[]) => {
    for (const statement of splitStatements(sql)) {
      const offending = findForeignTable(statement, prefix);

      if (offending) {
        throw new Error(
          `Extension "${extensionId}" migration touches ${offending}, which is outside its "${prefix}" namespace: ${statement}`
        );
      }
    }

    return query(sql, ...(rest as [unknown[]?]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');

  const statements: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (const char of withoutComments) {
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }

    if (char === ';') {
      statements.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  statements.push(current);

  return statements.map((statement) => statement.trim()).filter(Boolean);
}

const BARE_IDENTIFIER = String.raw`"[^"]+"|\`[^\`]+\`|[A-Za-z_][\w$]*`;
const QUALIFIER = String.raw`(?:(?:${BARE_IDENTIFIER})\s*\.\s*)?`;
// An identifier, optionally quoted and optionally schema-qualified. Captured,
// so a matched pattern's groups are exactly the table names it found.
const IDENTIFIER = `${QUALIFIER}(${BARE_IDENTIFIER})`;
// The same, uncaptured, for identifiers that name something other than a table.
const OTHER_IDENTIFIER = `${QUALIFIER}(?:${BARE_IDENTIFIER})`;

/** The DDL forms we can attribute to a table, and where the table name sits. */
const TABLE_PATTERNS = [
  new RegExp(
    String.raw`^CREATE\s+(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP|TEMPORARY|UNLOGGED\s+)?\s*TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENTIFIER}`,
    'i'
  ),
  new RegExp(
    String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${IDENTIFIER}`,
    'i'
  ),
  new RegExp(String.raw`^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${IDENTIFIER}`, 'i'),
  new RegExp(
    String.raw`^TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?${IDENTIFIER}`,
    'i'
  ),
  new RegExp(
    String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:${OTHER_IDENTIFIER}\s+)?ON\s+${IDENTIFIER}`,
    'i'
  ),
  // The target of a rename, which the patterns above only see the source of.
  new RegExp(String.raw`\bRENAME\s+TO\s+${IDENTIFIER}`, 'i'),
];

/**
 * DDL that names no table at all. Allowed because there is nothing to check,
 * not because it is known to be safe — see {@link enforceTablePrefix}.
 */
const TABLELESS_DDL =
  /^(?:DROP|ALTER)\s+INDEX\b|^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

const DDL_VERB =
  /^(?:CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|COMMENT)\b/i;

/**
 * Returns a description of the table this statement touches if the extension
 * does not own it, or `undefined` if the statement is allowed.
 */
function findForeignTable(
  statement: string,
  prefix: string
): string | undefined {
  if (!DDL_VERB.test(statement)) {
    // DML and queries are the extension's business; only schema changes are
    // namespaced.
    return undefined;
  }

  if (TABLELESS_DDL.test(statement)) {
    return undefined;
  }

  const tables = TABLE_PATTERNS.flatMap((pattern) => {
    const match = statement.match(pattern);
    return match ? match.slice(1).filter((name): name is string => !!name) : [];
  }).map(unquote);

  if (tables.length === 0) {
    // Schema-changing SQL we could not attribute to a table — a view, a
    // trigger, a sequence, a grant. Refused rather than waved through, since
    // the whole point is to keep an extension inside its own namespace.
    return 'an unrecognized schema object';
  }

  const offending = tables.find((table) => !isOwnedTable(table, prefix));

  return offending ? `table "${offending}"` : undefined;
}

function isOwnedTable(table: string, prefix: string): boolean {
  // `temporary_<table>` is how sqlite migrations rewrite a table in place.
  return table.startsWith(prefix) || table.startsWith(`temporary_${prefix}`);
}

function unquote(identifier: string): string {
  return identifier.replace(/^["`]|["`]$/g, '');
}

function toArray<T>(value: MixedList<T>): T[] {
  return Array.isArray(value) ? value : Object.values(value ?? {});
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * The main DataSource's connection options, so extension migrations land in the
 * core database. Only the connection details are reused — {@link runOne}
 * overrides everything about what the short-lived DataSource *does*.
 */
function defaultBaseOptions(): DataSourceOptions {
  return dataSource.options;
}
