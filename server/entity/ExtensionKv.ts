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
    } catch {
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
