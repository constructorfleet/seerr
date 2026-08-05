/**
 * The notification type bitmask, shared by the server and the client.
 *
 * This module is deliberately **import-free**, like
 * `server/lib/extensions/sharedModuleSpecifiers.ts`. It lives here rather than in
 * `server/lib/notifications` because that module imports `logger` (winston) and
 * `UserSettings` imports typeorm — either would drag a server-only dependency
 * into the client bundle. `server/constants/*` is already the place the client
 * reads runtime enums from (`MediaServerType`, `IssueStatus`, `MediaType`).
 *
 * Having exactly one home is the point. `src/components/NotificationTypeSelector`
 * used to declare its own copy, which fell behind when the server gained
 * `EXTENSION` — 8190 on the client against 16382 on the server — and because
 * `ALL_NOTIFICATIONS` is the default for a user who has never saved notification
 * settings, that silently switched extension notifications off for them.
 */
export enum Notification {
  NONE = 0,
  MEDIA_PENDING = 2,
  MEDIA_APPROVED = 4,
  MEDIA_AVAILABLE = 8,
  MEDIA_FAILED = 16,
  TEST_NOTIFICATION = 32,
  MEDIA_DECLINED = 64,
  MEDIA_AUTO_APPROVED = 128,
  ISSUE_CREATED = 256,
  ISSUE_COMMENT = 512,
  ISSUE_RESOLVED = 1024,
  ISSUE_REOPENED = 2048,
  MEDIA_AUTO_REQUESTED = 4096,
  /**
   * **One** sentinel for every extension-contributed notification, never one
   * member per extension.
   *
   * `ALL_NOTIFICATIONS` sums this enum at import time and is persisted per user as
   * a resolved integer, so a member per extension would make every user's saved
   * mask depend on what happens to be installed. Which extension event a user
   * actually wants is a row in `ext_notification_subscription`, keyed by the
   * namespaced string; this bit only says "extension notifications, on this
   * agent". `payload.extensionEvent` carries the event's identity for display.
   *
   * Never renumber this — it is already in users' saved masks. A branch adding its
   * own notification types must pick a different bit rather than shifting this one.
   */
  EXTENSION = 8192,
}

/**
 * Every notification type, summed. Persisted per user, and used as the default
 * for the email and webpush agents when a user has saved nothing.
 */
export const ALL_NOTIFICATIONS = Object.values(Notification)
  .filter((v) => !isNaN(Number(v)))
  .reduce((a, v) => a + Number(v), 0);
