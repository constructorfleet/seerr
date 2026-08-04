/**
 * The jobs endpoints, as they behave once an extension has contributed a job.
 *
 * `settings.jobs` is a `Record<JobId, JobSettings>` of core's thirteen ids, so a
 * namespaced extension job id has no entry there — the reschedule path must say
 * so rather than dereferencing `undefined`.
 */
import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';

import { scheduleExtensionJobs } from '@server/job/extensionJobs';
import { scheduledJobs } from '@server/job/schedule';
import type { ExtensionJob } from '@server/lib/extensions/registry';
import {
  ExtensionRegistrations,
  ExtensionRegistry,
} from '@server/lib/extensions/registry';
import { getSettings } from '@server/lib/settings';
import routes from '@server/routes';
import { setupTestDb } from '@server/test/db';
import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import request from 'supertest';

setupTestDb();

const API_KEY = 'settings-jobs-test-api-key';
const EVERY_MINUTE = '0 * * * * *';

let app: Express;

before(() => {
  getSettings().main.apiKey = API_KEY;

  app = express();
  app.use(express.json());
  app.use('/api/v1', routes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: Request,
      res: Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
});

afterEach(() => {
  for (const job of scheduledJobs.splice(0, scheduledJobs.length)) {
    job.job.cancel();
  }
});

function asAdmin(pending: request.Test): request.Test {
  return pending.set('X-API-Key', API_KEY).set('X-API-User', '1');
}

function scheduleOne(overrides: Partial<ExtensionJob> = {}): void {
  const registry = new ExtensionRegistry();
  const entry = {
    id: 'demo',
    directory: '/tmp/demo',
    status: 'pending' as const,
    entities: [],
    migrations: [],
  };
  registry.add(entry);

  const registrations = new ExtensionRegistrations();
  registrations.jobs.push({
    extensionId: 'demo',
    id: 'sync',
    name: 'Sync',
    schedule: EVERY_MINUTE,
    run: async () => undefined,
    ...overrides,
  });
  registry.commit(entry, registrations);

  scheduleExtensionJobs(registry);
}

describe('settings jobs with extension jobs scheduled', () => {
  it('lists an extension job alongside core jobs', async () => {
    scheduleOne();

    const res = await asAdmin(request(app).get('/api/v1/settings/jobs'));

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(
      res.body.map((job: { id: string }) => job.id),
      ['demo:sync']
    );
  });

  it('runs an extension job on demand', async () => {
    let ran = 0;
    scheduleOne({
      run: async () => {
        ran += 1;
      },
    });

    const res = await asAdmin(
      request(app).post('/api/v1/settings/jobs/demo:sync/run')
    );

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id, 'demo:sync');
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(ran, 1);
  });

  it('refuses to reschedule an extension job', async () => {
    scheduleOne();

    const res = await asAdmin(
      request(app).post('/api/v1/settings/jobs/demo:sync/schedule')
    ).send({ schedule: '0 */2 * * * *' });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /manifest/i);
  });

  it('leaves the extension job on its manifest schedule', async () => {
    scheduleOne();

    await asAdmin(
      request(app).post('/api/v1/settings/jobs/demo:sync/schedule')
    ).send({ schedule: '0 */2 * * * *' });

    assert.strictEqual(scheduledJobs[0].cronSchedule, EVERY_MINUTE);
  });

  it('still 404s a job id nothing registered', async () => {
    const res = await asAdmin(
      request(app).post('/api/v1/settings/jobs/absent:sync/schedule')
    ).send({ schedule: EVERY_MINUTE });

    assert.strictEqual(res.status, 404);
  });
});
