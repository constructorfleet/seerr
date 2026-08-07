/**
 * Deactivation: what "disable" means to a *running* Seerr.
 *
 * The asymmetry under test is the point of the feature. Enabling an extension that
 * was off at boot cannot work in place — its entities had to be injected before
 * `dataSource.initialize()` — but disabling one has no such obstacle, because
 * everything a live extension contributes is a list the host owns. So these tests
 * pin that each of those lists loses the extension's entries, that its own
 * teardown runs, and that a neighbour is untouched.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { extensionJobId } from '@server/job/extensionJobs';
import { scheduledJobs } from '@server/job/schedule';
import {
  clearExtensionEventSource,
  emitExtensionEvent,
  setExtensionEventSource,
} from '@server/lib/extensions/events';
import { deactivateExtension } from '@server/lib/extensions/lifecycle';
import type { ExtensionManifest } from '@server/lib/extensions/manifest';
import type {
  ExtensionDisposer,
  ExtensionEntry,
} from '@server/lib/extensions/registry';
import {
  ExtensionRegistrations,
  ExtensionRegistry,
} from '@server/lib/extensions/registry';
import { EXTENSION_ROUTE_OPEN } from '@server/lib/extensions/types';

interface FakeExtension {
  id: string;
  routes?: number;
  jobs?: string[];
  panels?: string[];
  events?: number;
  disposers?: ExtensionDisposer[];
}

/** A registry in the state activation leaves it in. */
function registryWith(extensions: FakeExtension[]): ExtensionRegistry {
  const registry = new ExtensionRegistry();

  for (const extension of extensions) {
    const entry: ExtensionEntry = {
      id: extension.id,
      directory: `/tmp/${extension.id}`,
      manifest: {
        id: extension.id,
        name: extension.id,
        version: '1.0.0',
        provides: {
          panels: (extension.panels ?? []).map((slug) => ({
            slug,
            title: slug,
            entry: 'dist/panel.mjs',
          })),
        },
      } as unknown as ExtensionManifest,
      status: 'pending',
      entities: [],
      migrations: [],
    };
    registry.add(entry);

    const registrations = new ExtensionRegistrations();

    for (let index = 0; index < (extension.routes ?? 0); index += 1) {
      registrations.routes.push({
        extensionId: extension.id,
        method: 'get',
        path: `/thing${index}`,
        options: { permission: EXTENSION_ROUTE_OPEN },
        handler: (_req, res) => {
          res.json({});
        },
      });
    }

    for (const id of extension.jobs ?? []) {
      registrations.jobs.push({
        extensionId: extension.id,
        id,
        name: id,
        schedule: '0 0 * * *',
        run: async () => undefined,
      });
    }

    for (let index = 0; index < (extension.events ?? 0); index += 1) {
      registrations.listeners.push({
        event: 'media.available',
        listener: { extensionId: extension.id, fn: () => undefined },
      });
    }

    registrations.disposers.push(...(extension.disposers ?? []));
    registry.commit(entry, registrations);
  }

  return registry;
}

afterEach(() => {
  clearExtensionEventSource();
  scheduledJobs.length = 0;
});

describe('deactivating a running extension', () => {
  it('drops its routes, jobs, panels and listeners', async () => {
    const registry = registryWith([
      {
        id: 'demo',
        routes: 2,
        jobs: ['sync'],
        panels: ['dashboard'],
        events: 1,
      },
    ]);

    assert.strictEqual(await deactivateExtension(registry, 'demo'), true);

    assert.deepStrictEqual(registry.routes(), []);
    assert.deepStrictEqual(registry.jobs(), []);
    assert.deepStrictEqual(registry.panels(), []);
    assert.strictEqual(registry.get('demo')?.status, 'disabled');
    assert.deepStrictEqual(registry.active(), []);
  });

  it('stops delivering events to it', async () => {
    let delivered = 0;
    const registry = registryWith([{ id: 'demo' }]);
    const entry = registry.get('demo');
    assert.ok(entry);

    // Committed a second time with a counting listener, rather than through the
    // fixture, so the assertion is about delivery and not about list length.
    const registrations = new ExtensionRegistrations();
    registrations.listeners.push({
      event: 'media.available',
      listener: {
        extensionId: 'demo',
        fn: () => {
          delivered += 1;
        },
      },
    });
    registry.commit(entry, registrations);
    setExtensionEventSource(registry);

    await emitExtensionEvent('media.available', {} as never);
    assert.strictEqual(delivered, 1);

    await deactivateExtension(registry, 'demo');
    await emitExtensionEvent('media.available', {} as never);

    assert.strictEqual(delivered, 1);
  });

  it('leaves another extension’s registrations alone', async () => {
    const registry = registryWith([
      { id: 'demo-one', routes: 1, jobs: ['sync'], panels: ['one'], events: 1 },
      { id: 'demo-two', routes: 1, jobs: ['sync'], panels: ['two'], events: 1 },
    ]);

    await deactivateExtension(registry, 'demo-one');

    assert.deepStrictEqual(
      registry.routes().map((route) => route.extensionId),
      ['demo-two']
    );
    assert.deepStrictEqual(
      registry.jobs().map((job) => job.extensionId),
      ['demo-two']
    );
    assert.deepStrictEqual(
      registry.panels().map((panel) => panel.extensionId),
      ['demo-two']
    );
    assert.strictEqual(registry.get('demo-two')?.status, 'active');
  });

  it('cancels its scheduled jobs and removes them from Settings → Jobs', async () => {
    const registry = registryWith([
      { id: 'demo', jobs: ['sync'] },
      { id: 'other', jobs: ['sync'] },
    ]);

    let cancelled = false;
    for (const [extensionId, onCancel] of [
      ['demo', () => (cancelled = true)],
      ['other', () => undefined],
    ] as const) {
      scheduledJobs.push({
        id: extensionJobId(extensionId, 'sync'),
        name: 'Sync',
        type: 'process',
        interval: 'fixed',
        cronSchedule: '0 0 * * *',
        job: { cancel: onCancel } as never,
      });
    }

    await deactivateExtension(registry, 'demo');

    assert.strictEqual(cancelled, true);
    assert.deepStrictEqual(
      scheduledJobs.map((job) => job.id),
      ['other:sync']
    );
  });

  it('does not touch a core job that shares no namespace', async () => {
    const registry = registryWith([{ id: 'demo', jobs: ['sync'] }]);
    scheduledJobs.push({
      id: 'plex-recently-added-scan',
      name: 'Plex Recently Added Scan',
      type: 'process',
      interval: 'minutes',
      cronSchedule: '0 * * * *',
      job: {
        cancel: () => assert.fail('cancelled a core job'),
      } as never,
    });

    await deactivateExtension(registry, 'demo');

    assert.strictEqual(scheduledJobs.length, 1);
  });
});

describe('an extension’s own teardown', () => {
  it('runs its disposers in reverse registration order', async () => {
    const order: string[] = [];
    const registry = registryWith([
      {
        id: 'demo',
        disposers: [
          () => {
            order.push('first');
          },
          () => {
            order.push('second');
          },
        ],
      },
    ]);

    await deactivateExtension(registry, 'demo');

    // Reverse, so an extension that acquired A then B releases B then A.
    assert.deepStrictEqual(order, ['second', 'first']);
  });

  it('awaits an async disposer', async () => {
    let released = false;
    const registry = registryWith([
      {
        id: 'demo',
        disposers: [
          async () => {
            await new Promise((resolve) => setImmediate(resolve));
            released = true;
          },
        ],
      },
    ]);

    await deactivateExtension(registry, 'demo');

    assert.strictEqual(released, true);
  });

  it('runs the remaining disposers when one throws, and still succeeds', async () => {
    let ran = false;
    const registry = registryWith([
      {
        id: 'demo',
        disposers: [
          () => {
            ran = true;
          },
          () => {
            throw new Error('teardown exploded');
          },
        ],
      },
    ]);

    // Contained: the extension is already out of service by the time a disposer
    // runs, so a teardown failure must not report the disable as having failed.
    assert.strictEqual(await deactivateExtension(registry, 'demo'), true);
    assert.strictEqual(ran, true);
    assert.strictEqual(registry.get('demo')?.status, 'disabled');
  });

  it('takes the extension out of service before its teardown runs', async () => {
    let statusDuringTeardown: string | undefined;
    const registry = registryWith([{ id: 'demo', routes: 1 }]);
    const entry = registry.get('demo');
    assert.ok(entry);

    const registrations = new ExtensionRegistrations();
    registrations.disposers.push(() => {
      // A disposer closing a client must not race a request handler admitted a
      // moment earlier, so the registry mutation happens first.
      statusDuringTeardown = registry.get('demo')?.status;
      assert.deepStrictEqual(registry.routes(), []);
    });
    registry.commit(entry, registrations);

    await deactivateExtension(registry, 'demo');

    assert.strictEqual(statusDuringTeardown, 'disabled');
  });

  it('does not run them twice when disable is repeated', async () => {
    let runs = 0;
    const registry = registryWith([
      {
        id: 'demo',
        disposers: [
          () => {
            runs += 1;
          },
        ],
      },
    ]);

    await deactivateExtension(registry, 'demo');
    assert.strictEqual(await deactivateExtension(registry, 'demo'), false);

    assert.strictEqual(runs, 1);
  });
});

describe('deactivating something that is not running', () => {
  it('reports false for an extension that was never loaded', async () => {
    assert.strictEqual(
      await deactivateExtension(new ExtensionRegistry(), 'absent'),
      false
    );
  });

  it('reports false for a quarantined extension, and leaves it failed', async () => {
    const registry = new ExtensionRegistry();
    registry.add({
      id: 'demo',
      directory: '/tmp/demo',
      status: 'pending',
      entities: [],
      migrations: [],
    });
    registry.fail('demo', new Error('boom'), 'running its entry point');

    assert.strictEqual(await deactivateExtension(registry, 'demo'), false);

    // Not rewritten to `disabled`: the operator needs to keep seeing *why* it is
    // not running, and the stored `error` is the only record of that.
    assert.strictEqual(registry.get('demo')?.status, 'failed');
    assert.strictEqual(registry.get('demo')?.error, 'boom');
  });
});
