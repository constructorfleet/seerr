/**
 * `ALL_NOTIFICATIONS` and the `Notification` enum it sums.
 *
 * These are pinned because the value is **persisted**: `user_settings.notificationTypes`
 * stores a resolved integer per user, so the enum's numbering is a data format, not
 * an implementation detail.
 *
 * The bug that motivated these tests was a *second* copy of the enum in
 * `src/components/NotificationTypeSelector/index.tsx`, which stopped at
 * `MEDIA_AUTO_REQUESTED` and so computed 8190 against this module's 16382. That
 * copy is gone — the client now imports from here — and there is deliberately no
 * test asserting the two stay in sync, because a server test cannot import from
 * `src/` (`@app/*` is unmapped in `server/tsconfig.json`). Having one home for the
 * enum is what makes the drift unrepresentable; these tests only pin the home.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ALL_NOTIFICATIONS } from '@server/entity/UserSettings';
import { Notification } from '@server/lib/notifications';

describe('the Notification enum', () => {
  it('keeps every member on its own bit', () => {
    const values = Object.values(Notification).filter(
      (value): value is number => typeof value === 'number' && value !== 0
    );

    for (const value of values) {
      assert.equal(
        value & (value - 1),
        0,
        `${value} is not a single bit, so it overlaps another notification type`
      );
    }

    assert.equal(
      new Set(values).size,
      values.length,
      'two members share a value, so one silently enables the other'
    );
  });

  it('keeps EXTENSION on bit 13', () => {
    // Never renumber this. It is already persisted in users' saved masks, and a
    // branch adding its own notification types must pick a different bit rather
    // than shifting this one. See the member's own comment.
    assert.equal(Notification.EXTENSION, 8192);
  });

  it('sums every member into ALL_NOTIFICATIONS', () => {
    assert.equal(ALL_NOTIFICATIONS, 16382);
  });

  it('includes the extension sentinel in ALL_NOTIFICATIONS', () => {
    // The concrete regression: a user who has never saved notification settings
    // is defaulted to ALL_NOTIFICATIONS, so an omitted sentinel means extension
    // notifications are off for them with nothing in the UI to explain why.
    assert.equal(
      ALL_NOTIFICATIONS & Notification.EXTENSION,
      Notification.EXTENSION
    );
  });
});
