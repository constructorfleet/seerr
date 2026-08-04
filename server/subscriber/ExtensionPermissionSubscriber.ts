import { User } from '@server/entity/User';
import { grantDefaultExtensionPermissions } from '@server/lib/extensions/permissions';
import logger from '@server/logger';
import type { EntitySubscriberInterface, InsertEvent } from 'typeorm';
import { EventSubscriber } from 'typeorm';

/**
 * Grants the `default: true` extension permissions to every newly created user.
 *
 * A subscriber rather than a call in each route, because users are created from
 * six places (the admin form, local sign-up, Plex and Jellyfin sign-in, and
 * import) that all set `permissions: settings.main.defaultPermissions` and would
 * all have to remember an extension-specific step. This is the same spirit as
 * core's defaults without touching that mechanism.
 */
@EventSubscriber()
export class ExtensionPermissionSubscriber implements EntitySubscriberInterface<User> {
  public listenTo(): typeof User {
    return User;
  }

  public async afterInsert(event: InsertEvent<User>): Promise<void> {
    if (!event.entity?.id) {
      return;
    }

    try {
      // The event's manager, so the grants land in the same transaction as the
      // user: a rolled-back insert must not leave rows for a user that does not
      // exist.
      await grantDefaultExtensionPermissions(event.entity.id, event.manager);
    } catch (e) {
      // A failure here must not fail user creation — an operator locked out of
      // sign-up by an extension's default permission is a far worse outcome than
      // a user who has to be granted it by hand.
      logger.error('Failed to grant default extension permissions', {
        label: 'Extensions',
        userId: event.entity.id,
        errorMessage: e.message,
      });
    }
  }
}
