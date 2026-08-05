import { Notification } from '@server/constants/notification';
import type { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import logger from '@server/logger';
import type { NotificationAgent, NotificationPayload } from './agents/agent';

/**
 * Re-exported so existing `@server/lib/notifications` importers keep working. The
 * enum itself lives in `@server/constants/notification`, which imports nothing, so
 * the client can read it without pulling winston or typeorm into its bundle.
 */
export { Notification };

export const hasNotificationType = (
  types: Notification | Notification[],
  value: number
): boolean => {
  let total: number;

  // If we are not checking any notifications, bail out and return true
  if (types === 0) {
    return true;
  }

  if (Array.isArray(types)) {
    // Combine all notification values into one
    total = types.reduce((a, v) => a + v, 0);
  } else {
    total = types;
  }

  // Test notifications don't need to be enabled
  if (!(value & Notification.TEST_NOTIFICATION)) {
    value += Notification.TEST_NOTIFICATION;
  }

  return !!(value & total);
};

export const getAdminPermission = (type: Notification): Permission => {
  switch (type) {
    case Notification.MEDIA_PENDING:
    case Notification.MEDIA_APPROVED:
    case Notification.MEDIA_AVAILABLE:
    case Notification.MEDIA_FAILED:
    case Notification.MEDIA_DECLINED:
    case Notification.MEDIA_AUTO_APPROVED:
      return Permission.MANAGE_REQUESTS;
    case Notification.ISSUE_CREATED:
    case Notification.ISSUE_COMMENT:
    case Notification.ISSUE_RESOLVED:
    case Notification.ISSUE_REOPENED:
      return Permission.MANAGE_ISSUES;
    default:
      return Permission.ADMIN;
  }
};

export const shouldSendAdminNotification = (
  type: Notification,
  user: User,
  payload: NotificationPayload
): boolean => {
  return (
    user.id !== payload.notifyUser?.id &&
    user.hasPermission(getAdminPermission(type)) &&
    // Check if the user submitted this request (on behalf of themself OR another user)
    (type !== Notification.MEDIA_AUTO_APPROVED ||
      user.id !==
        (payload.request?.modifiedBy ?? payload.request?.requestedBy)?.id) &&
    // Check if the user created this issue
    (type !== Notification.ISSUE_CREATED ||
      user.id !== payload.issue?.createdBy.id) &&
    // Check if the user submitted this issue comment
    (type !== Notification.ISSUE_COMMENT ||
      user.id !== payload.comment?.user.id) &&
    // Check if the user resolved/reopened this issue
    ((type !== Notification.ISSUE_RESOLVED &&
      type !== Notification.ISSUE_REOPENED) ||
      user.id !== payload.issue?.modifiedBy?.id)
  );
};

class NotificationManager {
  private activeAgents: NotificationAgent[] = [];

  public registerAgents = (agents: NotificationAgent[]): void => {
    this.activeAgents = [...this.activeAgents, ...agents];
    logger.info('Registered notification agents', { label: 'Notifications' });
  };

  public sendNotification(
    type: Notification,
    payload: NotificationPayload
  ): void {
    logger.info(`Sending notification(s) for ${Notification[type]}`, {
      label: 'Notifications',
      subject: payload.subject,
    });

    this.activeAgents.forEach((agent) => {
      // Each agent is isolated: sends are fire-and-forget, so an agent that
      // throws synchronously would abort the loop and silently skip every agent
      // after it, and one that rejects would raise an unhandled rejection.
      // Extension notifications make this reachable — one send fans out to every
      // subscriber, and one bad agent must not swallow the rest of them.
      try {
        if (agent.shouldSend()) {
          agent.send(type, payload)?.catch((e) => {
            logger.error('A notification agent failed to send', {
              label: 'Notifications',
              agent: agent.constructor?.name,
              type: Notification[type],
              subject: payload.subject,
              errorMessage: e instanceof Error ? e.message : String(e),
            });
          });
        }
      } catch (e) {
        logger.error('A notification agent failed to send', {
          label: 'Notifications',
          agent: agent.constructor?.name,
          type: Notification[type],
          subject: payload.subject,
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
    });
  }
}

const notificationManager = new NotificationManager();

export default notificationManager;
