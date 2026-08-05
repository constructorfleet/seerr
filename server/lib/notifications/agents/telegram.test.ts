/**
 * The Telegram agent's MarkdownV2 body.
 *
 * `getNotificationPayload` is exercised directly rather than through `send`: the
 * defect is in the text the agent builds, and Telegram is the only judge of
 * whether the escaping is right — a mocked `axios.post` would assert the same
 * string with more machinery in the way.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { initI18n } from '@server/i18n';
import { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import TelegramAgent from '@server/lib/notifications/agents/telegram';

initI18n();

function buildText(payload: NotificationPayload): string {
  const agent = new TelegramAgent({
    enabled: true,
    embedPoster: false,
    types: 0,
    options: {
      botAPI: 'token',
      chatId: '1',
      messageThreadId: '',
      sendSilently: false,
    },
  });

  const built = (
    agent as unknown as {
      getNotificationPayload: (
        type: Notification,
        payload: NotificationPayload
      ) => { text?: string; caption?: string; parse_mode: string };
    }
  ).getNotificationPayload(Notification.EXTENSION, payload);

  assert.strictEqual(built.parse_mode, 'MarkdownV2');

  return built.text ?? built.caption ?? '';
}

describe('the Telegram agent’s MarkdownV2 escaping', () => {
  /**
   * The reference extensions put `settings.main.applicationTitle` in an extra, so
   * a perfectly ordinary title like `media.example.com` used to reach Telegram
   * unescaped and be rejected with a 400 — losing every extension notification
   * for every Telegram subscriber while the other agents delivered.
   */
  it('escapes the name and value of an extra', () => {
    const text = buildText({
      subject: 'Watched something',
      notifySystem: true,
      notifyAdmin: false,
      extra: [{ name: 'Application (title)', value: 'media.example.com' }],
    });

    assert.match(
      text,
      /\n\*Application \\\(title\\\):\* media\\\.example\\\.com$/
    );
  });

  it('escapes a value that would otherwise open markup', () => {
    const text = buildText({
      subject: 'Watched something',
      notifySystem: true,
      notifyAdmin: false,
      extra: [{ name: 'Note', value: '*bold* _italic_ [link](http://evil)' }],
    });

    assert.ok(
      text.endsWith('\\*bold\\* \\_italic\\_ \\[link\\]\\(http://evil\\)'),
      `unescaped markup in ${text}`
    );
  });

  it('still escapes the subject', () => {
    const text = buildText({
      subject: 'Seerr - Home',
      notifySystem: true,
      notifyAdmin: false,
    });

    assert.match(text, /^\*Seerr \\- Home\*$/);
  });
});
