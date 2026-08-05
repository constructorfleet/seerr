/**
 * Dialect-aware column declaration, mirroring `server/utils/DbColumnHelper.ts`.
 *
 * ## Why an extension needs this
 *
 * Seerr runs on sqlite *or* Postgres, and TypeORM does not paper over the
 * difference for date columns: sqlite has `datetime`, Postgres wants
 * `timestamp with time zone`. Core writes every date through its own
 * `DbAwareColumn`, so core entities are portable. An extension had no equivalent
 * — the host helper imports `@server/datasource`, which is not resolvable outside
 * the Seerr repository — so an author writing the obvious thing:
 *
 * ```ts
 * @Column({ type: 'datetime' })
 * public watchedAt: Date;
 * ```
 *
 * got an extension that worked on their sqlite dev box and failed on a
 * Postgres deployment. That is the worst shape a portability bug can take: it
 * cannot be reproduced by the person who wrote it.
 *
 * ## Why reading the environment is correct here, not a shortcut
 *
 * The mapping has to be decided when the decorator runs, which is when the
 * entity module is first imported — and for an extension that is at
 * **discovery**, before `dataSource.initialize()`. So a DataSource cannot be
 * consulted even in principle; there isn't one yet.
 *
 * Deciding from `process.env.DB_TYPE` is not a workaround for that, though: it is
 * exactly what the host does. `server/datasource.ts` computes
 * `isPgsql = process.env.DB_TYPE === 'postgres'` at module scope and never asks a
 * connection either. Extensions are `require()`d into the Seerr process, so they
 * read the same variable the host read, and the two cannot disagree — which is
 * the property that matters, since extension tables live in core's database.
 *
 * The `=== 'postgres'` comparison is duplicated rather than shared, deliberately:
 * this package has no runtime coupling to Seerr internals, which
 * `sdkPackage.test.ts` enforces. `sdkColumns.test.ts` pins the agreement instead,
 * including the unset-`DB_TYPE`-means-sqlite case where a plausible-looking
 * `!== 'sqlite'` would diverge.
 */
import type { ColumnOptions, ColumnType } from 'typeorm';
import { Column } from 'typeorm';

/**
 * Column types that differ between the dialects Seerr supports.
 *
 * Only `datetime` today, matching core's `pgTypeMapping` exactly. Anything absent
 * here passes through untouched, which is the right default: TypeORM handles the
 * rest, and silently rewriting a type core does not rewrite would put an
 * extension's schema out of step with its host.
 */
const POSTGRES_TYPE_MAPPING: Record<string, ColumnType> = {
  datetime: 'timestamp with time zone',
};

/**
 * Whether the host is running on Postgres.
 *
 * Read once at module scope, as the host does. A test that needs the other
 * dialect has to use a fresh process — see `sdkColumns.test.ts`.
 */
const isPostgres = process.env.DB_TYPE === 'postgres';

/**
 * Resolves a column type for the dialect the host is running on.
 *
 * Use this for `@UpdateDateColumn`/`@CreateDateColumn`, whose options TypeORM
 * reads differently and which {@link DbAwareColumn} therefore cannot wrap:
 *
 * ```ts
 * @UpdateDateColumn({ type: resolveColumnType('datetime') })
 * public updatedAt: Date;
 * ```
 */
export function resolveColumnType(type: ColumnType): ColumnType {
  if (isPostgres) {
    const mapped = POSTGRES_TYPE_MAPPING[type.toString()];

    if (mapped) {
      return mapped;
    }
  }

  return type;
}

/**
 * `@Column`, with its type resolved for the host's dialect.
 *
 * ```ts
 * @DbAwareColumn({ type: 'datetime', nullable: true })
 * public watchedAt?: Date;
 * ```
 *
 * Unlike core's version this does not assign back into the caller's object.
 * Core gets away with mutating because every call site passes a fresh literal;
 * an extension reusing one options object across several columns would otherwise
 * find the first call had rewritten it for all of them.
 */
export function DbAwareColumn(options: ColumnOptions): PropertyDecorator {
  if (!options.type) {
    return Column(options);
  }

  return Column({ ...options, type: resolveColumnType(options.type) });
}
