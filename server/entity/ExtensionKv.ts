import logger from '@server/logger';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, UpdateDateColumn } from 'typeorm';

export type ExtensionKvValue = unknown;

// convert between DB representation (JSON string) and the parsed value. Stored
// as text rather than a dialect-specific json type so one entity definition
// works on both sqlite and Postgres, the same reason `DbAwareColumn` exists.
const jsonValueTransformer = {
  from: (v: string | null): ExtensionKvValue => {
    if (v == null) {
      return null;
    }
    try {
      return JSON.parse(v);
    } catch (e) {
      // Still `null`, because throwing here would fail the whole query for one
      // bad row and a transformer has no way to report a single value as
      // unreadable. But it must not be *silent*: `null` is also what an unset
      // key returns, so an extension using kv as a cursor would read a corrupt
      // row as "never run" and reprocess from the beginning, with nothing
      // anywhere saying why.
      //
      // A transformer's `from` is handed only the column value, so the
      // `extensionId` and `key` that would identify the row are not available
      // here; the truncated raw text is logged instead, as the only thing that
      // can be used to find it.
      logger.error('Discarding an unreadable extension kv value', {
        label: 'Extensions',
        errorMessage: e instanceof Error ? e.message : String(e),
        value: v.slice(0, 100),
      });

      return null;
    }
  },
  to: (v: ExtensionKvValue): string | null =>
    v === undefined ? null : JSON.stringify(v),
};

/**
 * Small per-extension key/value state, backing `sdk.store.kv`.
 *
 * A single core-owned table rather than an `ext_<id>_kv` table per extension:
 * the rows are namespaced by `extensionId` anyway, and this avoids making every
 * extension that only needs a cursor or a last-run timestamp ship a migration.
 * Extensions with real relational data declare their own `ext_<id>_*` tables.
 */
@Entity({ name: 'ext_kv' })
export class ExtensionKv {
  @Column({ type: 'varchar', primary: true })
  @Index()
  public extensionId: string;

  @Column({ type: 'varchar', primary: true })
  public key: string;

  @Column({ type: 'text', nullable: true, transformer: jsonValueTransformer })
  public value: ExtensionKvValue;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<ExtensionKv>) {
    Object.assign(this, init);
  }
}

export default ExtensionKv;
