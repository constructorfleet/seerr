import type Issue from '@server/entity/Issue';
import type IssueComment from '@server/entity/IssueComment';
import type Media from '@server/entity/Media';
import type MediaRemovalRequest from '@server/entity/MediaRemovalRequest';
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
  /**
   * Set instead of `request` for removal ("unrequest") notifications. Agents
   * read the two through {@link getRequestingUser} / {@link isRequest4k}, which
   * cover whichever one is present.
   */
  removalRequest?: MediaRemovalRequest;
  issue?: Issue;
  comment?: IssueComment;
  pendingRequestsCount?: number;
  isAdmin?: boolean;
}

/**
 * The user a request-shaped notification is about, whether it concerns an
 * addition or a removal.
 */
export const getRequestingUser = (
  payload: NotificationPayload
): User | undefined => (payload.request ?? payload.removalRequest)?.requestedBy;

/** Whether a request-shaped notification concerns the 4K variant. */
export const isRequest4k = (payload: NotificationPayload): boolean =>
  (payload.request ?? payload.removalRequest)?.is4k ?? false;

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
