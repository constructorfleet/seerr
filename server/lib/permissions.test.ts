import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasPermission, Permission } from '@server/lib/permissions';

describe('Permission', () => {
  it('assigns every permission a distinct value', () => {
    const values = Object.values(Permission).filter(
      (value): value is number => typeof value === 'number'
    );

    assert.strictEqual(new Set(values).size, values.length);
  });

  it('keeps every permission within the signed int32 range used by hasPermission', () => {
    // hasPermission relies on the bitwise `&` operator, which coerces its
    // operands to signed 32-bit integers, so bit 31 is unusable.
    for (const [name, value] of Object.entries(Permission)) {
      if (typeof value !== 'number') continue;
      assert.ok(
        value <= Permission.VIEW_BLOCKLIST,
        `${name} (${value}) exceeds the highest usable bit`
      );
    }
  });

  it('defines REQUEST_REMOVE', () => {
    assert.strictEqual(Permission.REQUEST_REMOVE, 536870912);
  });

  it('grants REQUEST_REMOVE to users holding it', () => {
    assert.ok(
      hasPermission(Permission.REQUEST_REMOVE, Permission.REQUEST_REMOVE)
    );
  });

  it('withholds REQUEST_REMOVE from users who only hold REQUEST', () => {
    assert.ok(!hasPermission(Permission.REQUEST_REMOVE, Permission.REQUEST));
  });

  it('grants REQUEST_REMOVE to admins', () => {
    assert.ok(hasPermission(Permission.REQUEST_REMOVE, Permission.ADMIN));
  });
});
