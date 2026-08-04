import type { ScheduledJob } from '@server/job/schedule';
import { scheduledJobs } from '@server/job/schedule';
import type {
  ExtensionJob,
  ExtensionRegistry,
} from '@server/lib/extensions/registry';
import logger from '@server/logger';
import schedule from 'node-schedule';

/**
 * `<extensionId>:<jobId>`, matching how permissions and notifications are
 * namespaced. Two extensions may both call their job `sync`, and the id is what
 * `POST /settings/jobs/:jobId/run` addresses.
 */
export function extensionJobId(extensionId: string, jobId: string): string {
  return `${extensionId}:${jobId}`;
}

/**
 * Adds the jobs the activated extensions registered to core's scheduler, so they
 * appear in Settings → Jobs alongside core's and can be run on demand.
 *
 * Only jobs an extension both declared in its manifest and registered a body for
 * arrive here — the loader pairs them — so the cron expression comes from the
 * manifest and has already been validated.
 */
export function scheduleExtensionJobs(registry: ExtensionRegistry): void {
  const jobs = registry.jobs();

  if (!jobs.length) {
    return;
  }

  let scheduled = 0;

  for (const job of jobs) {
    if (scheduleOne(job)) {
      scheduled += 1;
    }
  }

  logger.info(
    `Scheduled ${scheduled} extension job${scheduled === 1 ? '' : 's'}`,
    { label: 'Extensions' }
  );
}

function scheduleOne(job: ExtensionJob): boolean {
  const id = extensionJobId(job.extensionId, job.id);
  let running = false;

  const run = async (): Promise<void> => {
    if (running) {
      logger.warn('Skipping an extension job that is already running', {
        label: 'Extensions',
        extensionId: job.extensionId,
        jobId: id,
      });
      return;
    }

    running = true;
    logger.info(`Starting scheduled job: ${job.name}`, { label: 'Jobs' });

    try {
      await job.run();
    } catch (e) {
      // node-schedule does not await the callback, so an uncaught rejection here
      // would be an unhandled rejection in the host process.
      logger.error('Extension job failed', {
        label: 'Extensions',
        extensionId: job.extensionId,
        jobId: id,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    } finally {
      running = false;
    }
  };

  const scheduledJob = schedule.scheduleJob(job.schedule, () => {
    void run();
  });

  if (!scheduledJob) {
    // `scheduleJob` returns null for an expression it cannot parse. The manifest
    // schema validates the cron with cronstrue, which is more permissive in
    // places, so this is reachable without a bug on the extension's part.
    logger.error('Extension job could not be scheduled', {
      label: 'Extensions',
      extensionId: job.extensionId,
      jobId: id,
      schedule: job.schedule,
    });
    return false;
  }

  scheduledJobs.push({
    id,
    name: job.name,
    type: 'process',
    // `POST /settings/jobs/:jobId/schedule` writes `settings.jobs[job.id]`,
    // which has no entry for an extension job — `settings.jobs` is a
    // `Record<JobId, …>` of core's thirteen. The client hides the reschedule
    // button for a `fixed` interval, so reporting `fixed` keeps it from
    // offering an edit that core cannot persist. An extension's schedule is
    // changed by editing its manifest.
    interval: 'fixed',
    cronSchedule: job.schedule,
    job: scheduledJob,
    running: () => running,
  } satisfies ScheduledJob);

  return true;
}
