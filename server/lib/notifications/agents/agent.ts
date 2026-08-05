import type Issue from '@server/entity/Issue';
import type IssueComment from '@server/entity/IssueComment';
import type Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import type { NotificationAgentConfig } from '@server/lib/settings';
import type { Notification } from '..';

export interface NotificationPayload {
  event?: string;
  subject: string;
  notifySystem: boolean;
  notifyAdmin: boolean;
  notifyUser?: User;
  media?: Media;
  image?: string;
  message?: string;
  extra?: { name: string; value: string }[];
  request?: MediaRequest;
  issue?: Issue;
  comment?: IssueComment;
  pendingRequestsCount?: number;
  isAdmin?: boolean;
  /**
   * Which extension event this is, present exactly when `type` is
   * `Notification.EXTENSION`.
   *
   * Agents map a `Notification` value to a label with a `switch`; an extension
   * event has no value of its own, so this is what they fall back to for display
   * instead of dropping the notification or labelling it "Unknown".
   */
  extensionEvent?: {
    /** The extension's id. */
    id: string;
    /** The manifest-local notification key, not namespaced. */
    key: string;
    /** The manifest's human-readable name for the event. */
    name: string;
  };
}

export abstract class BaseAgent<T extends NotificationAgentConfig> {
  protected settings?: T;
  public constructor(settings?: T) {
    this.settings = settings;
  }

  protected abstract getSettings(): T;
}

export interface NotificationAgent {
  shouldSend(): boolean;
  send(type: Notification, payload: NotificationPayload): Promise<boolean>;
}
