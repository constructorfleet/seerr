import type { NotificationAgentKey } from '@server/lib/settings';

export interface UserSettingsGeneralResponse {
  username?: string;
  email?: string;
  locale?: string;
  discoverRegion?: string;
  streamingRegion?: string;
  originalLanguage?: string;
  movieQuotaLimit?: number;
  movieQuotaDays?: number;
  tvQuotaLimit?: number;
  tvQuotaDays?: number;
  globalMovieQuotaDays?: number;
  globalMovieQuotaLimit?: number;
  globalTvQuotaLimit?: number;
  globalTvQuotaDays?: number;
  watchlistSyncMovies?: boolean;
  watchlistSyncTv?: boolean;
}

/** One extension permission the installed extensions declare, for the editor UI. */
export interface UserSettingsExtensionPermissionOption {
  /** The namespaced `<extensionId>:<key>` string, which is what is granted. */
  permission: string;
  extensionId: string;
  name: string;
  description?: string;
  /** Names of the core `Permission` members this permission also requires. */
  requiresCore: string[];
}

export interface UserSettingsExtensionPermissionsResponse {
  /**
   * The permissions granted to this user, as stored. A permission whose
   * `requiresCore` is currently unmet still appears here, so the editor shows
   * the box an operator ticked.
   */
  permissions: string[];
  /**
   * The permissions that actually apply: every declared permission for an admin,
   * otherwise the granted ones whose `requiresCore` is satisfied.
   */
  effective: string[];
  /** Everything the installed, non-quarantined extensions declare. */
  available: UserSettingsExtensionPermissionOption[];
}

/** One extension notification the installed extensions declare, for the editor UI. */
export interface UserSettingsExtensionNotificationOption {
  /** The namespaced `<extensionId>:<key>` string, which is what is subscribed to. */
  notificationType: string;
  extensionId: string;
  name: string;
  description?: string;
  /** Whether newly created users are subscribed to it. */
  default: boolean;
}

/** A user's opt-in to one extension notification. */
export interface UserSettingsExtensionNotificationSubscription {
  notificationType: string;
  /** The agents to deliver on. Empty means every configured agent. */
  agents: NotificationAgentKey[];
}

export interface UserSettingsExtensionNotificationsResponse {
  /**
   * The subscriptions stored for this user. A subscription whose extension is
   * not currently loaded still appears here, so the editor shows the box a user
   * ticked and reinstalling restores it.
   */
  subscriptions: UserSettingsExtensionNotificationSubscription[];
  /** The subscriptions that currently deliver: the ones still declared. */
  effective: string[];
  /** Everything the installed, non-quarantined extensions declare. */
  available: UserSettingsExtensionNotificationOption[];
}

export type NotificationAgentTypes = Record<NotificationAgentKey, number>;
export interface UserSettingsNotificationsResponse {
  emailEnabled?: boolean;
  pgpKey?: string;
  discordEnabled?: boolean;
  discordEnabledTypes?: number;
  discordIds?: string[];
  pushbulletAccessToken?: string;
  pushoverApplicationToken?: string;
  pushoverUserKey?: string;
  pushoverSound?: string;
  telegramEnabled?: boolean;
  telegramBotUsername?: string;
  telegramChatId?: string;
  telegramMessageThreadId?: string;
  telegramSendSilently?: boolean;
  webPushEnabled?: boolean;
  notificationTypes: Partial<NotificationAgentTypes>;
}
