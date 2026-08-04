import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { MediaStatus, MediaType } from '@server/constants/media';
import Media from '@server/entity/Media';
import MediaRemovalRequest from '@server/entity/MediaRemovalRequest';
import { User } from '@server/entity/User';
import { initI18n } from '@server/i18n';
import { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import DiscordAgent from '@server/lib/notifications/agents/discord';
import EmailAgent from '@server/lib/notifications/agents/email';
import GotifyAgent from '@server/lib/notifications/agents/gotify';
import NtfyAgent from '@server/lib/notifications/agents/ntfy';
import PushbulletAgent from '@server/lib/notifications/agents/pushbullet';
import PushoverAgent from '@server/lib/notifications/agents/pushover';
import SlackAgent from '@server/lib/notifications/agents/slack';
import TelegramAgent from '@server/lib/notifications/agents/telegram';
import WebPushAgent from '@server/lib/notifications/agents/webpush';

const REMOVAL_TYPES = [
  Notification.MEDIA_REMOVAL_PENDING,
  Notification.MEDIA_REMOVAL_APPROVED,
  Notification.MEDIA_REMOVAL_DECLINED,
  Notification.MEDIA_REMOVAL_AUTO_APPROVED,
];

function buildPayload(
  overrides?: Partial<NotificationPayload>
): NotificationPayload {
  const requestedBy = new User();
  requestedBy.id = 2;
  requestedBy.username = 'friend';
  requestedBy.email = 'friend@seerr.dev';
  // Normally set by the @AfterLoad hook, which never runs for an in-memory
  // instance.
  requestedBy.setDisplayName();

  const media = new Media({
    id: 1,
    mediaType: MediaType.MOVIE,
    tmdbId: 550,
    status: MediaStatus.AVAILABLE,
    status4k: MediaStatus.UNKNOWN,
  });

  return {
    event: 'Movie Removal Request Approved',
    subject: 'Fight Club (1999)',
    notifySystem: true,
    notifyAdmin: false,
    media,
    removalRequest: new MediaRemovalRequest({
      id: 7,
      media,
      requestedBy,
      type: MediaType.MOVIE,
      is4k: false,
    }),
    ...overrides,
  };
}

// Each agent builds its user-visible body in a method that `send` then posts to
// a live endpoint. Reach for the body builder directly — the switch that misses
// a removal case is what actually regresses.
function reach<T>(agent: unknown, method: string) {
  return (
    agent as Record<
      string,
      (type: Notification, payload: NotificationPayload, locale?: string) => T
    >
  )[method].bind(agent);
}

function buildEmail(type: Notification, payload = buildPayload()): string {
  const body = (
    new EmailAgent() as unknown as {
      buildMessage: (
        type: Notification,
        payload: NotificationPayload,
        recipientEmail: string,
        recipientName?: string
      ) => { locals?: { body?: string } } | undefined;
    }
  ).buildMessage(type, payload, 'admin@seerr.dev', 'admin');

  return body?.locals?.body ?? '';
}

describe('removal notifications', () => {
  before(() => {
    initI18n();
  });

  it('renders a removal status in the Gotify body for every removal type', () => {
    const render = reach<{ message: string }>(
      new GotifyAgent(),
      'getNotificationPayload'
    );

    for (const type of REMOVAL_TYPES) {
      const { message } = render(type, buildPayload());

      assert.match(
        message,
        /friend/,
        `${Notification[type]} should credit the requester`
      );
      assert.match(
        message,
        /Request Status:\*\* \S/,
        `${Notification[type]} should render a non-empty status`
      );
    }
  });

  it('renders a removal status in the Ntfy body for every removal type', () => {
    const render = reach<{ message: string }>(new NtfyAgent(), 'buildPayload');

    for (const type of REMOVAL_TYPES) {
      const { message } = render(type, buildPayload());

      assert.match(message, /friend/);
      assert.match(
        message,
        /Request Status:\*\* \S/,
        `${Notification[type]} should render a non-empty status`
      );
    }
  });

  it('colors the Discord embed for every removal type', () => {
    const render = reach<{
      color: number;
      fields: { name: string; value: string }[];
    }>(new DiscordAgent(), 'buildEmbed');

    for (const type of REMOVAL_TYPES) {
      const embed = render(type, buildPayload());
      const statusField = embed.fields.find((field) =>
        /Status/.test(field.name)
      );

      assert.ok(
        statusField,
        `${Notification[type]} should include a status field`
      );
      assert.notStrictEqual(statusField?.value, '');
    }
  });

  it('renders a removal status in the Slack body for every removal type', () => {
    const render = reach<{ blocks: unknown[] }>(new SlackAgent(), 'buildEmbed');

    for (const type of REMOVAL_TYPES) {
      const { blocks } = render(type, buildPayload());
      const serialized = JSON.stringify(blocks);

      assert.match(serialized, /friend/);
      assert.match(
        serialized,
        /Request Status/,
        `${Notification[type]} should render a status field`
      );
    }
  });

  it('renders a removal status in the Telegram body for every removal type', () => {
    const render = reach<{ text: string }>(
      new TelegramAgent(),
      'getNotificationPayload'
    );

    for (const type of REMOVAL_TYPES) {
      const { text } = render(type, buildPayload());

      assert.match(text, /friend/);
      assert.match(
        text,
        /Request Status/,
        `${Notification[type]} should render a status field`
      );
    }
  });

  it('renders a removal status in the Pushover body for every removal type', async () => {
    const render = reach<Promise<{ message?: string }>>(
      new PushoverAgent(),
      'getNotificationPayload'
    );

    for (const type of REMOVAL_TYPES) {
      const { message } = await render(type, buildPayload());

      assert.match(message ?? '', /friend/);
      assert.match(
        message ?? '',
        /Request Status:<\/b> \S/,
        `${Notification[type]} should render a non-empty status`
      );
    }
  });

  it('renders a removal status in the Pushbullet body for every removal type', () => {
    const render = reach<{ body: string }>(
      new PushbulletAgent(),
      'getNotificationPayload'
    );

    for (const type of REMOVAL_TYPES) {
      const { body } = render(type, buildPayload());

      assert.match(body, /friend/);
      assert.match(
        body,
        /Request Status: \S/,
        `${Notification[type]} should render a non-empty status`
      );
    }
  });

  it('never falls back to the Unknown web push subject', () => {
    const render = reach<{ subject: string; message?: string }>(
      new WebPushAgent(),
      'getNotificationPayload'
    );

    for (const type of REMOVAL_TYPES) {
      const rendered = render(type, buildPayload());

      assert.notStrictEqual(
        rendered.subject,
        'Unknown',
        `${Notification[type]} hit the webpush default branch`
      );
      assert.ok(
        rendered.message,
        `${Notification[type]} should render a web push message`
      );
    }
  });

  it('renders distinct email bodies per removal type', () => {
    const bodies = REMOVAL_TYPES.map((type) => buildEmail(type));

    for (const [index, body] of bodies.entries()) {
      assert.notStrictEqual(
        body,
        '',
        `${Notification[REMOVAL_TYPES[index]]} rendered an empty email body`
      );
    }
    assert.strictEqual(
      new Set(bodies).size,
      bodies.length,
      'each removal type should read differently in email'
    );
  });

  it('distinguishes the 4K variant in email copy', () => {
    const forQuality = (is4k: boolean) =>
      buildEmail(
        Notification.MEDIA_REMOVAL_PENDING,
        buildPayload({
          removalRequest: new MediaRemovalRequest({
            id: 7,
            media: new Media({
              id: 1,
              mediaType: MediaType.MOVIE,
              tmdbId: 550,
            }),
            requestedBy: new User(),
            type: MediaType.MOVIE,
            is4k,
          }),
        })
      );

    assert.notStrictEqual(forQuality(true), forQuality(false));
    assert.match(forQuality(true), /4K/);
  });
});
