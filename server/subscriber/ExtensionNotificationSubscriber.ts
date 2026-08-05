import { User } from '@server/entity/User';
import { subscribeDefaultExtensionNotifications } from '@server/lib/extensions/notifications';
import logger from '@server/logger';
import type { EntitySubscriberInterface, InsertEvent } from 'typeorm';
import { EventSubscriber } from 'typeorm';

/**
 * Subscribes every newly created user to the `default: true` extension
 * notifications.
 *
 * A subscriber rather than a call in each route, for the same reason as
 * `ExtensionPermissionSubscriber`: users are created from six places (the admin
 * form, local sign-up, Plex and Jellyfin sign-in, and import) that would all have
 * to remember an extension-specific step.
 */
@EventSubscriber()
export class ExtensionNotificationSubscriber implements EntitySubscriberInterface<User> {
  public listenTo(): typeof User {
    return User;
  }

  public async afterInsert(event: InsertEvent<User>): Promise<void> {
    if (!event.entity?.id) {
      return;
    }

    try {
      // The event's manager, so the subscriptions land in the same transaction as
      // the user: a rolled-back insert must not leave rows for a user that does
      // not exist.
      await subscribeDefaultExtensionNotifications(
        event.entity.id,
        event.manager
      );
    } catch (e) {
      // A failure here must not fail user creation — an operator locked out of
      // sign-up by an extension's default notification is a far worse outcome
      // than a user who has to tick the box by hand.
      logger.error('Failed to subscribe default extension notifications', {
        label: 'Extensions',
        userId: event.entity.id,
        errorMessage: e.message,
      });
    }
  }
}
