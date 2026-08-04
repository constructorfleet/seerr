import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Notification, getAdminPermission } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';

const REMOVAL_TYPES = [
  'MEDIA_REMOVAL_PENDING',
  'MEDIA_REMOVAL_APPROVED',
  'MEDIA_REMOVAL_DECLINED',
  'MEDIA_REMOVAL_AUTO_APPROVED',
] as const;

describe('Notification', () => {
  it('assigns the removal notification types the next free bits', () => {
    assert.strictEqual(Notification.MEDIA_REMOVAL_PENDING, 8192);
    assert.strictEqual(Notification.MEDIA_REMOVAL_APPROVED, 16384);
    assert.strictEqual(Notification.MEDIA_REMOVAL_DECLINED, 32768);
    assert.strictEqual(Notification.MEDIA_REMOVAL_AUTO_APPROVED, 65536);
  });

  it('assigns every notification type a distinct value', () => {
    const values = Object.values(Notification).filter(
      (value): value is number => typeof value === 'number'
    );

    assert.strictEqual(new Set(values).size, values.length);
  });

  it('gives every notification type a single-bit value', () => {
    for (const [name, value] of Object.entries(Notification)) {
      if (typeof value !== 'number' || value === Notification.NONE) continue;
      assert.strictEqual(
        value & (value - 1),
        0,
        `${name} (${value}) is not a single bit`
      );
    }
  });
});

describe('getAdminPermission', () => {
  it('routes removal notifications to request managers rather than admins', () => {
    for (const type of REMOVAL_TYPES) {
      assert.strictEqual(
        getAdminPermission(Notification[type]),
        Permission.MANAGE_REQUESTS,
        `${type} should notify request managers`
      );
    }
  });
});
