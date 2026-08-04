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
