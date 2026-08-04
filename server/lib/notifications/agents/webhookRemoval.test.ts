import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MediaStatus, MediaType } from '@server/constants/media';
import Media from '@server/entity/Media';
import MediaRemovalRequest from '@server/entity/MediaRemovalRequest';
import { User } from '@server/entity/User';
import { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import WebhookAgent from '@server/lib/notifications/agents/webhook';
import type { NotificationAgentWebhook } from '@server/lib/settings';

// Mirrors the shipped default template: the `{{request}}` block key is nulled
// wholesale when the payload carries no request.
const DEFAULT_TEMPLATE = JSON.stringify({
  notification_type: '{{notification_type}}',
  subject: '{{subject}}',
  '{{request}}': {
    request_id: '{{request_id}}',
    requestedBy_username: '{{requestedBy_username}}',
    requestedBy_email: '{{requestedBy_email}}',
  },
});

function buildAgent(): WebhookAgent {
  const settings: NotificationAgentWebhook = {
    enabled: true,
    types: 0,
    embedPoster: false,
    options: {
      webhookUrl: 'https://example.invalid/hook',
      // buildPayload double-parses, matching how the setting is stored.
      jsonPayload: Buffer.from(JSON.stringify(DEFAULT_TEMPLATE)).toString(
        'base64'
      ),
      authHeader: '',
    },
  };

  return new WebhookAgent(settings);
}

function buildRemovalPayload(): NotificationPayload {
  const requestedBy = new User();
  requestedBy.id = 2;
  requestedBy.username = 'friend';
  requestedBy.email = 'friend@seerr.dev';
  // Normally populated by the @AfterLoad hook, which never runs for an
  // in-memory instance.
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
  };
}

function buildBody(payload: NotificationPayload): Record<string, unknown> {
  return (
    buildAgent() as unknown as {
      buildPayload: (
        type: Notification,
        payload: NotificationPayload
      ) => Record<string, unknown>;
    }
  ).buildPayload(Notification.MEDIA_REMOVAL_APPROVED, payload);
}

describe('webhook agent, removal notifications', () => {
  it('fills in the requester for a removal request', () => {
    const body = buildBody(buildRemovalPayload());
    const request = body.request as Record<string, unknown>;

    assert.strictEqual(request.requestedBy_username, 'friend');
    assert.strictEqual(request.requestedBy_email, 'friend@seerr.dev');
  });

  it('fills in the removal request id', () => {
    const body = buildBody(buildRemovalPayload());
    const request = body.request as Record<string, unknown>;

    // Interpolated into the template string, so it arrives stringified — same
    // as it does for an addition request.
    assert.strictEqual(request.request_id, '7');
  });

  it('keeps the request object populated for removal payloads', () => {
    const body = buildBody(buildRemovalPayload());

    assert.notStrictEqual(
      body.request,
      null,
      'a removal payload should still populate the request block'
    );
  });

  it('nulls the request block when there is neither kind of request', () => {
    const body = buildBody({
      subject: 'Test Notification',
      notifySystem: true,
      notifyAdmin: false,
    });

    assert.strictEqual(body.request, null);
  });
});
