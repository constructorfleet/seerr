import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  clearExtensionEventSource,
  emitExtensionEvent,
  setExtensionEventSource,
} from '@server/lib/extensions/events';
import {
  ExtensionRegistrations,
  ExtensionRegistry,
} from '@server/lib/extensions/registry';
import type {
  ExtensionEvent,
  ExtensionEventMap,
} from '@server/lib/extensions/types';

/**
 * The bus is generic over the event, so a literal payload cannot be typed
 * without building a real `Media` or `MediaRequest`. Nothing here reads the
 * payload's fields — only its identity — so it is cast at the one call site.
 */
function emit<TEvent extends ExtensionEvent>(
  event: TEvent,
  payload: unknown = {}
): Promise<void> {
  return emitExtensionEvent(event, payload as ExtensionEventMap[TEvent]);
}

interface Listener {
  extensionId: string;
  event: ExtensionEvent;
  fn: (payload: never) => void | Promise<void>;
}

/** A registry with `listeners` committed, as activation would leave it. */
function registryWith(listeners: Listener[]): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  const byExtension = new Map<string, Listener[]>();

  for (const listener of listeners) {
    byExtension.set(listener.extensionId, [
      ...(byExtension.get(listener.extensionId) ?? []),
      listener,
    ]);
  }

  for (const [extensionId, own] of byExtension) {
    const entry = {
      id: extensionId,
      directory: `/tmp/${extensionId}`,
      status: 'pending' as const,
      entities: [],
      migrations: [],
    };
    registry.add(entry);

    const registrations = new ExtensionRegistrations();
    registrations.listeners.push(
      ...own.map((listener) => ({
        event: listener.event,
        listener: { extensionId, fn: listener.fn },
      }))
    );
    registry.commit(entry, registrations);
  }

  return registry;
}

afterEach(() => {
  clearExtensionEventSource();
});

describe('extension event bus', () => {
  it('delivers an event to a listener', async () => {
    const seen: unknown[] = [];
    setExtensionEventSource(
      registryWith([
        {
          extensionId: 'demo',
          event: 'request.approved',
          fn: (payload) => {
            seen.push(payload);
          },
        },
      ])
    );

    const payload = { request: { id: 7 } };
    await emit('request.approved', payload);

    assert.deepStrictEqual(seen, [payload]);
  });

  it('delivers to every listener of the event', async () => {
    const seen: string[] = [];
    setExtensionEventSource(
      registryWith([
        {
          extensionId: 'one',
          event: 'media.available',
          fn: () => {
            seen.push('one');
          },
        },
        {
          extensionId: 'two',
          event: 'media.available',
          fn: () => {
            seen.push('two');
          },
        },
      ])
    );

    await emit('media.available');

    assert.deepStrictEqual(seen.sort(), ['one', 'two']);
  });

  it('does not deliver an event nobody listened for', async () => {
    const seen: string[] = [];
    setExtensionEventSource(
      registryWith([
        {
          extensionId: 'demo',
          event: 'media.available',
          fn: () => {
            seen.push('called');
          },
        },
      ])
    );

    await emit('media.partially-available');

    assert.deepStrictEqual(seen, []);
  });

  /**
   * The emit sites are inside core's own subscribers. A listener that throws
   * there must not surface as a failed media save.
   */
  it('does not reject when a listener throws', async () => {
    const seen: string[] = [];
    setExtensionEventSource(
      registryWith([
        {
          extensionId: 'broken',
          event: 'request.created',
          fn: () => {
            throw new Error('listener exploded');
          },
        },
        {
          extensionId: 'demo',
          event: 'request.created',
          fn: () => {
            seen.push('demo');
          },
        },
      ])
    );

    await emit('request.created');

    assert.deepStrictEqual(seen, ['demo']);
  });

  it('does not reject when a listener rejects', async () => {
    setExtensionEventSource(
      registryWith([
        {
          extensionId: 'broken',
          event: 'request.failed',
          fn: async () => {
            throw new Error('listener rejected');
          },
        },
      ])
    );

    await emit('request.failed');
  });

  it('is a no-op with no source set', async () => {
    await emit('media.available');
  });

  it('stops delivering once the source is cleared', async () => {
    const seen: string[] = [];
    setExtensionEventSource(
      registryWith([
        {
          extensionId: 'demo',
          event: 'media.available',
          fn: () => {
            seen.push('called');
          },
        },
      ])
    );
    clearExtensionEventSource();

    await emit('media.available');

    assert.deepStrictEqual(seen, []);
  });
});
