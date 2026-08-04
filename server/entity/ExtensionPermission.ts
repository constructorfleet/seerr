import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { User } from './User';

/**
 * A single extension permission granted to a user, keyed by the namespaced
 * `<extensionId>:<key>` string the extension declares in its manifest.
 *
 * Rows rather than a bitmask on `user.permissions`: core's `Permission` enum has
 * exactly one free bit left, so extensions get their own unbounded string-keyed
 * space. A row belonging to an uninstalled extension is inert instead of
 * ambiguous, which a recycled bit would not be.
 */
@Entity({ name: 'ext_permission' })
export class ExtensionPermission {
  @Column({ type: 'integer', primary: true })
  @Index()
  public userId: number;

  @Column({ type: 'varchar', primary: true })
  @Index()
  public permission: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  public user?: User;

  constructor(init?: Partial<ExtensionPermission>) {
    Object.assign(this, init);
  }
}

export default ExtensionPermission;
