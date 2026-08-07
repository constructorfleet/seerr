import type { NotificationAgentKey } from '@server/lib/settings';
import logger from '@server/logger';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { User } from './User';

// convert between DB representation (JSON string) into typescript array
const jsonArrayTransformer = {
  from: (v: string | null): NotificationAgentKey[] => {
    if (!v) {
      return [];
    }

    try {
      return JSON.parse(v);
    } catch (e) {
      // An empty list is indistinguishable from "subscribed to nothing", so a
      // corrupt row would silently stop delivering a user's notifications. The
      // fallback stays — one bad row must not fail the query — but it says so.
      logger.error('Discarding an unreadable notification subscription', {
        label: 'Extensions',
        errorMessage: e instanceof Error ? e.message : String(e),
        value: v.slice(0, 100),
      });

      return [];
    }
  },
  to: (v: NotificationAgentKey[] | null): string | null =>
    v?.length ? JSON.stringify(v) : null,
};

/**
 * Which notification agents a user wants a given extension event delivered to.
 *
 * Deliberately not part of core's `user_settings.notificationTypes` bitmask:
 * `ALL_NOTIFICATIONS` is the sum of every `Notification` enum value computed at
 * import time, so extension-contributed enum members would make every user's
 * persisted mask depend on which extensions happen to be installed. String keys
 * with their own rows are stable across install and uninstall.
 */
@Entity({ name: 'ext_notification_subscription' })
export class ExtensionNotificationSubscription {
  @Column({ type: 'integer', primary: true })
  @Index()
  public userId: number;

  /** Namespaced as `<extensionId>:<key>`. */
  @Column({ type: 'varchar', primary: true })
  public notificationType: string;

  @Column({ type: 'text', nullable: true, transformer: jsonArrayTransformer })
  public agents: NotificationAgentKey[];

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  public user?: User;

  constructor(init?: Partial<ExtensionNotificationSubscription>) {
    Object.assign(this, init);
  }
}

export default ExtensionNotificationSubscription;
