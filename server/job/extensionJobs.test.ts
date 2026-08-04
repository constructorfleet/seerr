import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  extensionJobId,
  scheduleExtensionJobs,
} from '@server/job/extensionJobs';
import { scheduledJobs } from '@server/job/schedule';
import type { ExtensionJob } from '@server/lib/extensions/registry';
import {
  ExtensionRegistrations,
  ExtensionRegistry,
} from '@server/lib/extensions/registry';

/** Every minute, so a scheduled job always has a next invocation. */
const EVERY_MINUTE = '0 * * * * *';

function registryWith(jobs: Partial<ExtensionJob>[]): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  const byExtension = new Map<string, Partial<ExtensionJob>[]>();

  for (const job of jobs) {
    const extensionId = job.extensionId ?? 'demo';
    byExtension.set(extensionId, [
      ...(byExtension.get(extensionId) ?? []),
      job,
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
    registrations.jobs.push(
      ...own.map(
        (job): ExtensionJob => ({
          extensionId,
          id: job.id ?? 'sync',
          name: job.name ?? 'Sync',
          schedule: job.schedule ?? EVERY_MINUTE,
          run: job.run ?? (async () => undefined),
        })
      )
    );
    registry.commit(entry, registrations);
  }

  return registry;
}

afterEach(() => {
  // `scheduledJobs` is a module-global core owns; leave it as it was found, and
  // cancel the node-schedule jobs so the test runner's event loop can drain.
  for (const job of scheduledJobs.splice(0, scheduledJobs.length)) {
    job.job.cancel();
  }
});

describe('extension job scheduling', () => {
  it('adds a registered job to the core scheduler', () => {
    scheduleExtensionJobs(
      registryWith([{ id: 'sync', name: 'Sync Watch History' }])
    );

    assert.strictEqual(scheduledJobs.length, 1);
    assert.strictEqual(scheduledJobs[0].id, 'demo:sync');
    assert.strictEqual(scheduledJobs[0].name, 'Sync Watch History');
    assert.strictEqual(scheduledJobs[0].cronSchedule, EVERY_MINUTE);
  });

  it('namespaces the job id against its extension', () => {
    assert.strictEqual(
      extensionJobId('watch-history', 'sync'),
      'watch-history:sync'
    );
  });

  /**
   * `POST /settings/jobs/:jobId/schedule` writes `settings.jobs[job.id]`, which
   * has no entry for an extension job. The client hides the reschedule button
   * for a `fixed` interval, so this is what keeps it from posting an id core
   * cannot persist.
   */
  it('reports the job as fixed-interval so the client offers no reschedule', () => {
    scheduleExtensionJobs(registryWith([{}]));

    assert.strictEqual(scheduledJobs[0].interval, 'fixed');
  });

  it('keeps the jobs of two extensions apart', () => {
    scheduleExtensionJobs(
      registryWith([
        { extensionId: 'one', id: 'sync' },
        { extensionId: 'two', id: 'sync' },
      ])
    );

    assert.deepStrictEqual(scheduledJobs.map((job) => job.id).sort(), [
      'one:sync',
      'two:sync',
    ]);
  });

  it('runs the registered body when the job is invoked', async () => {
    let ran = 0;
    scheduleExtensionJobs(
      registryWith([
        {
          run: async () => {
            ran += 1;
          },
        },
      ])
    );

    await scheduledJobs[0].job.invoke();

    assert.strictEqual(ran, 1);
  });

  it('reports a job as running only while its body is in flight', async () => {
    let release = () => undefined as void;
    const started = new Promise<void>((resolve) => {
      scheduleExtensionJobs(
        registryWith([
          {
            run: () =>
              new Promise<void>((finish) => {
                release = () => finish();
                resolve();
              }),
          },
        ])
      );
    });

    assert.strictEqual(scheduledJobs[0].running?.(), false);

    const invocation = scheduledJobs[0].job.invoke();
    await started;
    assert.strictEqual(scheduledJobs[0].running?.(), true);

    release();
    await invocation;
    // The job body settles a tick after the promise it returned.
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(scheduledJobs[0].running?.(), false);
  });

  it('does not run a job again while the previous run is in flight', async () => {
    let starts = 0;
    let release = () => undefined as void;
    scheduleExtensionJobs(
      registryWith([
        {
          run: () =>
            new Promise<void>((finish) => {
              starts += 1;
              release = () => finish();
            }),
        },
      ])
    );

    const first = scheduledJobs[0].job.invoke();
    await new Promise((resolve) => setImmediate(resolve));
    await scheduledJobs[0].job.invoke();

    assert.strictEqual(starts, 1);

    release();
    await first;
  });

  /** A rejecting job body must not become an unhandled rejection. */
  it('survives a job body that rejects', async () => {
    scheduleExtensionJobs(
      registryWith([
        {
          run: async () => {
            throw new Error('job exploded');
          },
        },
      ])
    );

    await scheduledJobs[0].job.invoke();
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(scheduledJobs[0].running?.(), false);
  });

  it('skips a job whose schedule node-schedule refuses', () => {
    scheduleExtensionJobs(
      registryWith([
        { id: 'broken', schedule: 'not a cron expression' },
        { id: 'sync' },
      ])
    );

    assert.deepStrictEqual(
      scheduledJobs.map((job) => job.id),
      ['demo:sync']
    );
  });

  it('adds nothing when no extension registered a job', () => {
    scheduleExtensionJobs(new ExtensionRegistry());

    assert.strictEqual(scheduledJobs.length, 0);
  });
});
