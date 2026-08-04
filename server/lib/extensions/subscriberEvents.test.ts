/**
 * The event bus, wired to the real subscribers.
 *
 * `server/lib/extensions/events.test.ts` covers the bus itself; this covers the
 * emit sites, which are the part that can silently stop firing. Core's own
 * behaviour is asserted alongside every emit, because the whole constraint on
 * these call sites is that they change nothing core does.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import {
  clearExtensionEventSource,
  setExtensionEventSource,
} from '@server/lib/extensions/events';
import {
  ExtensionRegistrations,
  ExtensionRegistry,
} from '@server/lib/extensions/registry';
import type { ExtensionEvent } from '@server/lib/extensions/types';
import { setupTestDb } from '@server/test/db';

setupTestDb();

interface Recorded {
  event: ExtensionEvent;
  payload: Record<string, unknown>;
}

/**
 * Listens for every event in the map and records what arrives, so a test can
 * assert both what fired and what did not.
 */
function record(options: { throws?: boolean } = {}): Recorded[] {
  const recorded: Recorded[] = [];
  const events: ExtensionEvent[] = [
    'media.available',
    'media.partially-available',
    'request.created',
    'request.approved',
    'request.declined',
    'request.available',
    'request.failed',
  ];

  const registry = new ExtensionRegistry();
  const entry = {
    id: 'recorder',
    directory: '/tmp/recorder',
    status: 'pending' as const,
    entities: [],
    migrations: [],
  };
  registry.add(entry);

  const registrations = new ExtensionRegistrations();
  registrations.listeners.push(
    ...events.map((event) => ({
      event,
      listener: {
        extensionId: 'recorder',
        fn: (payload: never) => {
          recorded.push({ event, payload: payload as Record<string, unknown> });

          if (options.throws) {
            throw new Error('listener exploded');
          }
        },
      },
    }))
  );
  registry.commit(entry, registrations);
  setExtensionEventSource(registry);

  return recorded;
}

function eventsOf(recorded: Recorded[]): ExtensionEvent[] {
  return recorded.map((entry) => entry.event);
}

afterEach(() => {
  clearExtensionEventSource();
});

function getUser(email: string): Promise<User> {
  return getRepository(User).findOneOrFail({ where: { email } });
}

function createMedia(overrides?: Partial<Media>): Promise<Media> {
  return getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 550,
      status: MediaStatus.PROCESSING,
      status4k: MediaStatus.UNKNOWN,
      ...overrides,
    })
  );
}

/** Saves through the repository, so the subscriber runs as it does in core. */
async function setMediaStatus(
  media: Media,
  status: Partial<Pick<Media, 'status' | 'status4k'>>
): Promise<void> {
  const repository = getRepository(Media);
  const fresh = await repository.findOneOrFail({ where: { id: media.id } });

  Object.assign(fresh, status);
  await repository.save(fresh);
}

describe('media events', () => {
  it('emits media.available when media becomes available', async () => {
    const recorded = record();
    const media = await createMedia();

    await setMediaStatus(media, { status: MediaStatus.AVAILABLE });

    assert.deepStrictEqual(eventsOf(recorded), ['media.available']);
    assert.strictEqual(recorded[0].payload.is4k, false);
    assert.strictEqual((recorded[0].payload.media as Media).id, media.id);
  });

  it('emits media.partially-available separately', async () => {
    const recorded = record();
    const media = await createMedia({ mediaType: MediaType.TV });

    await setMediaStatus(media, { status: MediaStatus.PARTIALLY_AVAILABLE });

    assert.deepStrictEqual(eventsOf(recorded), ['media.partially-available']);
  });

  it('reports the 4k variant with is4k true', async () => {
    const recorded = record();
    const media = await createMedia({ status4k: MediaStatus.PROCESSING });

    await setMediaStatus(media, { status4k: MediaStatus.AVAILABLE });

    assert.deepStrictEqual(eventsOf(recorded), ['media.available']);
    assert.strictEqual(recorded[0].payload.is4k, true);
  });

  it('does not emit when the status did not change', async () => {
    const media = await createMedia({ status: MediaStatus.AVAILABLE });
    const recorded = record();

    await setMediaStatus(media, { status: MediaStatus.AVAILABLE });

    assert.deepStrictEqual(eventsOf(recorded), []);
  });

  it('does not emit for a status no extension event covers', async () => {
    const recorded = record();
    const media = await createMedia();

    await setMediaStatus(media, { status: MediaStatus.DELETED });

    assert.deepStrictEqual(eventsOf(recorded), []);
  });

  /**
   * The emit is inside `MediaSubscriber.afterUpdate`, which runs in core's write
   * path: a throwing extension listener must not fail the save.
   */
  it('saves the media even when a listener throws', async () => {
    record({ throws: true });
    const media = await createMedia();

    await setMediaStatus(media, { status: MediaStatus.AVAILABLE });

    const found = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
    });
    assert.strictEqual(found.status, MediaStatus.AVAILABLE);
  });
});

async function createRequest(
  overrides?: Partial<MediaRequest>
): Promise<MediaRequest> {
  return getRepository(MediaRequest).save(
    new MediaRequest({
      status: MediaRequestStatus.PENDING,
      media: await createMedia(),
      requestedBy: await getUser('friend@seerr.dev'),
      type: MediaType.MOVIE,
      ...overrides,
    })
  );
}

async function setRequestStatus(
  request: MediaRequest,
  status: MediaRequestStatus
): Promise<void> {
  const repository = getRepository(MediaRequest);
  const fresh = await repository.findOneOrFail({
    where: { id: request.id },
    relations: { media: true, requestedBy: true },
  });

  fresh.status = status;
  await repository.save(fresh);
}

describe('request events', () => {
  it('emits request.created when a request is inserted', async () => {
    const recorded = record();

    const request = await createRequest();

    assert.ok(eventsOf(recorded).includes('request.created'));
    const created = recorded.find((entry) => entry.event === 'request.created');
    assert.strictEqual(
      (created?.payload.request as MediaRequest).id,
      request.id
    );
  });

  it('emits request.approved on approval', async () => {
    const request = await createRequest();
    const recorded = record();

    await setRequestStatus(request, MediaRequestStatus.APPROVED);

    assert.ok(eventsOf(recorded).includes('request.approved'));
    assert.ok(!eventsOf(recorded).includes('request.declined'));
  });

  it('emits request.declined on decline', async () => {
    const request = await createRequest();
    const recorded = record();

    await setRequestStatus(request, MediaRequestStatus.DECLINED);

    assert.ok(eventsOf(recorded).includes('request.declined'));
  });

  it('emits request.available on completion', async () => {
    const request = await createRequest({
      status: MediaRequestStatus.APPROVED,
    });
    const recorded = record();

    await setRequestStatus(request, MediaRequestStatus.COMPLETED);

    assert.ok(eventsOf(recorded).includes('request.available'));
  });

  it('emits request.failed on failure', async () => {
    const request = await createRequest({
      status: MediaRequestStatus.APPROVED,
    });
    const recorded = record();

    await setRequestStatus(request, MediaRequestStatus.FAILED);

    assert.ok(eventsOf(recorded).includes('request.failed'));
  });

  it('does not re-emit when the status is unchanged', async () => {
    const request = await createRequest({
      status: MediaRequestStatus.APPROVED,
    });
    const recorded = record();

    await setRequestStatus(request, MediaRequestStatus.APPROVED);

    assert.ok(!eventsOf(recorded).includes('request.approved'));
  });

  it('saves the request even when a listener throws', async () => {
    const request = await createRequest();
    record({ throws: true });

    await setRequestStatus(request, MediaRequestStatus.DECLINED);

    const found = await getRepository(MediaRequest).findOneOrFail({
      where: { id: request.id },
    });
    assert.strictEqual(found.status, MediaRequestStatus.DECLINED);
  });
});
