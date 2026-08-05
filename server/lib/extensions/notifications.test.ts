import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { getRepository } from '@server/datasource';
import { ExtensionNotificationSubscription } from '@server/entity/ExtensionNotificationSubscription';
import { User } from '@server/entity/User';
import { ALL_NOTIFICATIONS, UserSettings } from '@server/entity/UserSettings';
import { initI18n } from '@server/i18n';
import type { ExtensionManifest } from '@server/lib/extensions/manifest';
import type { ExtensionNotificationDeclaration } from '@server/lib/extensions/notifications';
import {
  buildExtensionNotificationType,
  declarationsFromRegistry,
  getEffectiveExtensionNotifications,
  getExtensionNotificationDeclarations,
  getExtensionNotificationSubscriptions,
  isExtensionNotificationType,
  parseExtensionNotificationType,
  sendExtensionNotification,
  setExtensionNotificationDeclarations,
  setExtensionNotificationSubscriptions,
  subscribeDefaultExtensionNotifications,
  subscribeExtensionNotification,
  unsubscribeExtensionNotification,
} from '@server/lib/extensions/notifications';
import { ExtensionRegistry } from '@server/lib/extensions/registry';
import notificationManager, {
  Notification,
  hasNotificationType,
} from '@server/lib/notifications';
import type {
  NotificationAgent,
  NotificationPayload,
} from '@server/lib/notifications/agents/agent';
import EmailAgent from '@server/lib/notifications/agents/email';
import WebPushAgent from '@server/lib/notifications/agents/webpush';
import { NotificationAgentKey } from '@server/lib/settings';
import userRoutes from '@server/routes/user';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import request from 'supertest';

setupTestDb();
initI18n();

/**
 * The declarations a `watch-history` manifest would contribute: one subscribed
 * by default, one opt-in, plus a second extension so nothing depends on there
 * being only one.
 */
const declarations: ExtensionNotificationDeclaration[] = [
  {
    notificationType: 'watch-history:milestone',
    extensionId: 'watch-history',
    key: 'milestone',
    name: 'Watch Milestone',
    description: 'You hit a milestone.',
    default: true,
  },
  {
    notificationType: 'watch-history:digest',
    extensionId: 'watch-history',
    key: 'digest',
    name: 'Weekly Digest',
    default: false,
  },
  {
    notificationType: 'unrequest:removed',
    extensionId: 'unrequest',
    key: 'removed',
    name: 'Request Removed',
    default: false,
  },
];

/** Declares `declarations` for the duration of one test. */
function declare(
  only: ExtensionNotificationDeclaration[] = declarations
): void {
  setExtensionNotificationDeclarations(() => only);
}

afterEach(() => {
  setExtensionNotificationDeclarations(() => []);
});

function getUser(email: string): Promise<User> {
  return getRepository(User).findOneOrFail({ where: { email } });
}

describe('extension notification namespacing', () => {
  it('namespaces a manifest key under its extension id', () => {
    assert.strictEqual(
      buildExtensionNotificationType('watch-history', 'milestone'),
      'watch-history:milestone'
    );
  });

  it('round-trips a namespaced notification type', () => {
    const type = buildExtensionNotificationType('watch-history', 'milestone');

    assert.deepStrictEqual(parseExtensionNotificationType(type), {
      extensionId: 'watch-history',
      key: 'milestone',
    });
  });

  it('refuses to build a type for an invalid extension id', () => {
    assert.throws(() =>
      buildExtensionNotificationType('Watch_History', 'milestone')
    );
  });

  it('refuses to build a type for an invalid key', () => {
    assert.throws(() =>
      buildExtensionNotificationType('watch-history', 'Milestone!')
    );
  });

  it('does not parse a string without a separator', () => {
    assert.strictEqual(parseExtensionNotificationType('milestone'), undefined);
  });

  it('does not parse a string with more than one separator', () => {
    assert.strictEqual(
      parseExtensionNotificationType('watch-history:sub:milestone'),
      undefined
    );
  });

  it('recognizes a namespaced type and nothing else', () => {
    assert.strictEqual(
      isExtensionNotificationType('watch-history:milestone'),
      true
    );
    assert.strictEqual(isExtensionNotificationType('MEDIA_PENDING'), false);
  });
});

describe('declarationsFromRegistry', () => {
  function registryWith(
    status: 'pending' | 'active' | 'failed',
    manifest: Partial<ExtensionManifest>
  ): ExtensionRegistry {
    const registry = new ExtensionRegistry();
    registry.add({
      id: 'watch-history',
      directory: '/tmp/watch-history',
      status,
      entities: [],
      migrations: [],
      manifest: {
        id: 'watch-history',
        name: 'Watch History',
        version: '1.0.0',
        apiVersion: '^1.0.0',
        server: 'dist/server.js',
        ...manifest,
      } as ExtensionManifest,
    });

    return registry;
  }

  it('resolves the notifications an active extension declares', () => {
    const registry = registryWith('active', {
      provides: {
        notifications: [
          {
            key: 'milestone',
            name: 'Watch Milestone',
            description: 'You hit a milestone.',
            default: true,
          },
          { key: 'digest', name: 'Weekly Digest' },
        ],
      },
    });

    assert.deepStrictEqual(declarationsFromRegistry(registry), [
      {
        notificationType: 'watch-history:milestone',
        extensionId: 'watch-history',
        key: 'milestone',
        name: 'Watch Milestone',
        description: 'You hit a milestone.',
        default: true,
      },
      {
        notificationType: 'watch-history:digest',
        extensionId: 'watch-history',
        key: 'digest',
        name: 'Weekly Digest',
        default: false,
      },
    ]);
  });

  it('ignores a quarantined extension', () => {
    const registry = registryWith('failed', {
      provides: { notifications: [{ key: 'milestone', name: 'Milestone' }] },
    });

    assert.deepStrictEqual(declarationsFromRegistry(registry), []);
  });

  it('declares nothing for an extension with no notifications', () => {
    assert.deepStrictEqual(
      declarationsFromRegistry(registryWith('active', {})),
      []
    );
  });
});

describe('extension notification subscriptions', () => {
  it('reports no subscriptions for a user who has none', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    assert.deepStrictEqual(
      await getExtensionNotificationSubscriptions(friend.id),
      []
    );
  });

  it('subscribes a user to a namespaced type', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    await subscribeExtensionNotification(friend.id, 'watch-history:milestone');

    assert.deepStrictEqual(
      await getExtensionNotificationSubscriptions(friend.id),
      [{ notificationType: 'watch-history:milestone', agents: [] }]
    );
  });

  it('stores the agents a subscription names', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    await subscribeExtensionNotification(friend.id, 'watch-history:milestone', [
      NotificationAgentKey.EMAIL,
    ]);

    assert.deepStrictEqual(
      await getExtensionNotificationSubscriptions(friend.id),
      [
        {
          notificationType: 'watch-history:milestone',
          agents: [NotificationAgentKey.EMAIL],
        },
      ]
    );
  });

  it('is idempotent', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    await subscribeExtensionNotification(friend.id, 'watch-history:milestone');
    await subscribeExtensionNotification(friend.id, 'watch-history:milestone');

    assert.strictEqual(
      (await getExtensionNotificationSubscriptions(friend.id)).length,
      1
    );
  });

  it('refuses a type that is not namespaced', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    await assert.rejects(
      () => subscribeExtensionNotification(friend.id, 'MEDIA_PENDING'),
      /namespaced/
    );
  });

  it('unsubscribes a user', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    await subscribeExtensionNotification(friend.id, 'watch-history:milestone');

    await unsubscribeExtensionNotification(
      friend.id,
      'watch-history:milestone'
    );

    assert.deepStrictEqual(
      await getExtensionNotificationSubscriptions(friend.id),
      []
    );
  });

  it('replaces a user’s subscriptions with exactly the ones submitted', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    await subscribeExtensionNotification(friend.id, 'watch-history:milestone');

    await setExtensionNotificationSubscriptions(friend.id, [
      {
        notificationType: 'watch-history:digest',
        agents: [NotificationAgentKey.WEBPUSH],
      },
    ]);

    assert.deepStrictEqual(
      await getExtensionNotificationSubscriptions(friend.id),
      [
        {
          notificationType: 'watch-history:digest',
          agents: [NotificationAgentKey.WEBPUSH],
        },
      ]
    );
  });

  it('refuses a type no installed extension declares', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    await assert.rejects(
      () =>
        setExtensionNotificationSubscriptions(friend.id, [
          { notificationType: 'nothing:at_all', agents: [] },
        ]),
      /nothing:at_all/
    );

    assert.deepStrictEqual(
      await getExtensionNotificationSubscriptions(friend.id),
      []
    );
  });

  it('refuses an unknown notification agent', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    await assert.rejects(
      () =>
        setExtensionNotificationSubscriptions(friend.id, [
          {
            notificationType: 'watch-history:milestone',
            agents: ['carrier-pigeon' as NotificationAgentKey],
          },
        ]),
      /carrier-pigeon/
    );
  });

  it('reports only the subscriptions a loaded extension still declares as effective', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    await subscribeExtensionNotification(friend.id, 'watch-history:milestone');
    await subscribeExtensionNotification(friend.id, 'gone-away:event');

    assert.deepStrictEqual(
      await getEffectiveExtensionNotifications(friend.id),
      ['watch-history:milestone']
    );
    // The uninstalled extension's row survives, so reinstalling it restores the
    // subscription rather than silently losing it.
    assert.deepStrictEqual(
      (await getExtensionNotificationSubscriptions(friend.id)).map(
        (subscription) => subscription.notificationType
      ),
      ['gone-away:event', 'watch-history:milestone']
    );
  });
});

describe('default extension notification subscriptions', () => {
  it('subscribes a user to the default: true types', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    await subscribeDefaultExtensionNotifications(friend.id);

    assert.deepStrictEqual(
      (await getExtensionNotificationSubscriptions(friend.id)).map(
        (subscription) => subscription.notificationType
      ),
      ['watch-history:milestone']
    );
  });

  it('subscribes a newly created user without any route knowing about it', async () => {
    declare();

    const created = await getRepository(User).save(
      new User({ email: 'newcomer@seerr.dev', avatar: '', permissions: 2 })
    );

    assert.deepStrictEqual(
      (await getExtensionNotificationSubscriptions(created.id)).map(
        (subscription) => subscription.notificationType
      ),
      ['watch-history:milestone']
    );
  });

  it('leaves a new user unsubscribed when nothing is installed', async () => {
    const created = await getRepository(User).save(
      new User({ email: 'newcomer@seerr.dev', avatar: '', permissions: 2 })
    );

    assert.deepStrictEqual(
      await getExtensionNotificationSubscriptions(created.id),
      []
    );
  });

  it('drops a subscription when its user is deleted', async () => {
    declare();
    const created = await getRepository(User).save(
      new User({ email: 'newcomer@seerr.dev', avatar: '', permissions: 2 })
    );

    await getRepository(User).delete({ id: created.id });

    assert.deepStrictEqual(
      await getRepository(ExtensionNotificationSubscription).find({
        where: { userId: created.id },
      }),
      []
    );
  });
});

describe('sendExtensionNotification', () => {
  interface Dispatch {
    type: Notification;
    payload: NotificationPayload;
  }

  /** Captures what the send path hands to `notificationManager`. */
  function capture(): Dispatch[] {
    const dispatches: Dispatch[] = [];

    mock.method(
      notificationManager,
      'sendNotification',
      (type: Notification, payload: NotificationPayload) => {
        dispatches.push({ type, payload });
      }
    );

    return dispatches;
  }

  afterEach(() => {
    mock.restoreAll();
  });

  it('delivers to a subscribed user and not to an unsubscribed one', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    await subscribeExtensionNotification(friend.id, 'watch-history:milestone');
    const dispatches = capture();

    await sendExtensionNotification('watch-history', 'milestone', {
      subject: 'Hello',
    });

    assert.deepStrictEqual(
      dispatches
        .filter((dispatch) => dispatch.payload.notifyUser)
        .map((dispatch) => dispatch.payload.notifyUser?.id),
      [friend.id]
    );
  });

  it('delivers nothing to a user subscribed to a different type', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    await subscribeExtensionNotification(friend.id, 'watch-history:digest');
    const dispatches = capture();

    await sendExtensionNotification('watch-history', 'milestone', {
      subject: 'Hello',
    });

    assert.deepStrictEqual(
      dispatches.filter((dispatch) => dispatch.payload.notifyUser),
      []
    );
  });

  it('sends under the single EXTENSION sentinel with a display descriptor', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    await subscribeExtensionNotification(friend.id, 'watch-history:milestone');
    const dispatches = capture();

    await sendExtensionNotification('watch-history', 'milestone', {
      subject: 'Hello',
      message: 'You watched 100 things',
    });

    const user = dispatches.find((dispatch) => dispatch.payload.notifyUser);
    assert.ok(user);
    assert.strictEqual(user.type, Notification.EXTENSION);
    assert.deepStrictEqual(user.payload.extensionEvent, {
      id: 'watch-history',
      key: 'milestone',
      name: 'Watch Milestone',
    });
    // `event` is what the agents that already render generically read.
    assert.strictEqual(user.payload.event, 'Watch Milestone');
    assert.strictEqual(user.payload.subject, 'Hello');
    assert.strictEqual(user.payload.message, 'You watched 100 things');
  });

  it('posts once to the system channels regardless of how many users subscribed', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    const admin = await getUser('admin@seerr.dev');
    await subscribeExtensionNotification(friend.id, 'watch-history:milestone');
    await subscribeExtensionNotification(admin.id, 'watch-history:milestone');
    const dispatches = capture();

    await sendExtensionNotification('watch-history', 'milestone', {
      subject: 'Hello',
    });

    assert.deepStrictEqual(
      dispatches.map((dispatch) => [
        dispatch.payload.notifySystem,
        dispatch.payload.notifyUser?.id,
      ]),
      [
        [true, undefined],
        [false, admin.id],
        [false, friend.id],
      ]
    );
  });

  it('never asks an agent to notify admins, which is not how extensions opt in', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    await subscribeExtensionNotification(friend.id, 'watch-history:milestone');
    const dispatches = capture();

    await sendExtensionNotification('watch-history', 'milestone', {
      subject: 'Hello',
    });

    assert.deepStrictEqual(
      dispatches.map((dispatch) => dispatch.payload.notifyAdmin),
      [false, false]
    );
  });

  it('enables the sentinel only on the agents the subscription names', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    await subscribeExtensionNotification(friend.id, 'watch-history:milestone', [
      NotificationAgentKey.EMAIL,
    ]);
    const dispatches = capture();

    await sendExtensionNotification('watch-history', 'milestone', {
      subject: 'Hello',
    });

    const settings = dispatches.find((dispatch) => dispatch.payload.notifyUser)
      ?.payload.notifyUser?.settings;
    assert.ok(settings);
    assert.strictEqual(
      settings.hasNotificationType(
        NotificationAgentKey.EMAIL,
        Notification.EXTENSION
      ),
      true
    );
    assert.strictEqual(
      settings.hasNotificationType(
        NotificationAgentKey.WEBPUSH,
        Notification.EXTENSION
      ),
      false
    );
  });

  it('enables every agent for a subscription that names none', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    await subscribeExtensionNotification(friend.id, 'watch-history:milestone');
    const dispatches = capture();

    await sendExtensionNotification('watch-history', 'milestone', {
      subject: 'Hello',
    });

    const settings = dispatches.find((dispatch) => dispatch.payload.notifyUser)
      ?.payload.notifyUser?.settings;
    assert.ok(settings);
    for (const key of Object.values(NotificationAgentKey)) {
      assert.strictEqual(
        settings.hasNotificationType(key, Notification.EXTENSION),
        true,
        `expected ${key} to be enabled`
      );
    }
  });

  it('does not persist the delivery mask it puts on the recipient', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    friend.settings = new UserSettings({
      user: friend,
      notificationTypes: { email: 2 },
    });
    await getRepository(User).save(friend);
    await subscribeExtensionNotification(friend.id, 'watch-history:milestone');
    capture();

    await sendExtensionNotification('watch-history', 'milestone', {
      subject: 'Hello',
    });

    const reloaded = await getUser('friend@seerr.dev');
    assert.strictEqual(reloaded.settings?.notificationTypes.email, 2);
  });

  it('refuses a key the extension does not declare', async () => {
    declare();

    await assert.rejects(
      () =>
        sendExtensionNotification('watch-history', 'not_declared', {
          subject: 'Hello',
        }),
      /watch-history:not_declared/
    );
  });

  it('passes the extension’s own notifyUser through as the only recipient', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    const admin = await getUser('admin@seerr.dev');
    await subscribeExtensionNotification(friend.id, 'watch-history:milestone');
    await subscribeExtensionNotification(admin.id, 'watch-history:milestone');
    const dispatches = capture();

    await sendExtensionNotification('watch-history', 'milestone', {
      subject: 'Hello',
      notifyUser: friend,
    });

    assert.deepStrictEqual(
      dispatches
        .filter((dispatch) => dispatch.payload.notifyUser)
        .map((dispatch) => dispatch.payload.notifyUser?.id),
      [friend.id]
    );
  });

  it('drops a notifyUser who is not subscribed', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    const dispatches = capture();

    await sendExtensionNotification('watch-history', 'milestone', {
      subject: 'Hello',
      notifyUser: friend,
    });

    assert.deepStrictEqual(
      dispatches.filter((dispatch) => dispatch.payload.notifyUser),
      []
    );
  });
});

describe('the Notification.EXTENSION sentinel', () => {
  /**
   * `ALL_NOTIFICATIONS` before the sentinel was added: the sum of every core
   * `Notification` member up to `MEDIA_AUTO_REQUESTED`. Hard-coded, because this
   * is the number already persisted in `user_settings.notificationTypes` for
   * every user of a Seerr that predates extensions.
   */
  const SAVED_BEFORE_EXTENSIONS = 8190;

  /** Every core type an existing saved mask was built from. */
  const preExistingTypes = [
    Notification.MEDIA_PENDING,
    Notification.MEDIA_APPROVED,
    Notification.MEDIA_AVAILABLE,
    Notification.MEDIA_FAILED,
    Notification.TEST_NOTIFICATION,
    Notification.MEDIA_DECLINED,
    Notification.MEDIA_AUTO_APPROVED,
    Notification.ISSUE_CREATED,
    Notification.ISSUE_COMMENT,
    Notification.ISSUE_RESOLVED,
    Notification.ISSUE_REOPENED,
    Notification.MEDIA_AUTO_REQUESTED,
  ];

  it('is a single fresh power of two, clear of the sign bit', () => {
    assert.strictEqual(Notification.EXTENSION, 8192);
    assert.strictEqual(
      Notification.EXTENSION & (Notification.EXTENSION - 1),
      0
    );
    assert.strictEqual(
      (SAVED_BEFORE_EXTENSIONS & Notification.EXTENSION) === 0,
      true
    );
    // Bit 31 would be unusable: `&` coerces to a signed int32.
    assert.strictEqual(Notification.EXTENSION < 2 ** 31, true);
  });

  it('is the only extension member of the enum', () => {
    const values = Object.values(Notification).filter(
      (value): value is number => typeof value === 'number'
    );

    assert.deepStrictEqual(values, [
      Notification.NONE,
      ...preExistingTypes,
      Notification.EXTENSION,
    ]);
  });

  it('adds exactly its own bit to ALL_NOTIFICATIONS', () => {
    assert.strictEqual(
      ALL_NOTIFICATIONS,
      SAVED_BEFORE_EXTENSIONS + Notification.EXTENSION
    );
  });

  it('leaves every pre-existing type answering identically for a mask saved before it existed', () => {
    for (const type of preExistingTypes) {
      assert.strictEqual(
        hasNotificationType(type, SAVED_BEFORE_EXTENSIONS),
        true,
        `expected ${Notification[type]} to still be enabled`
      );
    }

    // Extension opt-in is row-based: a mask that predates the sentinel must not
    // be read as an opt-in to every extension's notifications.
    assert.strictEqual(
      hasNotificationType(Notification.EXTENSION, SAVED_BEFORE_EXTENSIONS),
      false
    );
  });

  it('does not rewrite a mask that was saved before it existed', async () => {
    const friend = await getUser('friend@seerr.dev');
    friend.settings = new UserSettings({
      user: friend,
      notificationTypes: {
        email: SAVED_BEFORE_EXTENSIONS,
        webpush: SAVED_BEFORE_EXTENSIONS,
      },
    });
    await getRepository(User).save(friend);

    const reloaded = await getUser('friend@seerr.dev');

    assert.deepStrictEqual(reloaded.settings?.notificationTypes, {
      email: SAVED_BEFORE_EXTENSIONS,
      webpush: SAVED_BEFORE_EXTENSIONS,
    });
    assert.strictEqual(
      reloaded.settings?.hasNotificationType(
        NotificationAgentKey.EMAIL,
        Notification.MEDIA_AVAILABLE
      ),
      true
    );
    assert.strictEqual(
      reloaded.settings?.hasNotificationType(
        NotificationAgentKey.EMAIL,
        Notification.EXTENSION
      ),
      false
    );
  });
});

describe('agent display fallback', () => {
  const extensionPayload: NotificationPayload = {
    subject: 'You watched 100 things',
    message: 'Congratulations.',
    notifySystem: false,
    notifyAdmin: false,
    extensionEvent: {
      id: 'watch-history',
      key: 'milestone',
      name: 'Watch Milestone',
    },
  };

  it('renders an extension notification for web push instead of labelling it Unknown', () => {
    const agent = new WebPushAgent({
      enabled: true,
      embedPoster: false,
      types: 0,
      options: {},
    });

    const push = (
      agent as unknown as {
        getNotificationPayload: (
          type: Notification,
          payload: NotificationPayload
        ) => { notificationType: string; subject: string; message?: string };
      }
    ).getNotificationPayload(Notification.EXTENSION, extensionPayload);

    assert.strictEqual(push.notificationType, 'EXTENSION');
    assert.strictEqual(push.subject, 'You watched 100 things');
    assert.strictEqual(push.message, 'Congratulations.');
  });

  it('renders an extension notification for email instead of dropping it', () => {
    const agent = new EmailAgent({
      enabled: true,
      embedPoster: false,
      types: 0,
      options: {
        userEmailRequired: false,
        emailFrom: 'seerr@seerr.dev',
        smtpHost: 'localhost',
        smtpPort: 587,
        secure: false,
        ignoreTls: false,
        requireTls: false,
        allowSelfSigned: false,
        senderName: 'Seerr',
        usePublicLogo: false,
      },
    });

    const message = (
      agent as unknown as {
        buildMessage: (
          type: Notification,
          payload: NotificationPayload,
          recipientEmail: string,
          recipientName?: string
        ) => { template: string; locals: Record<string, unknown> } | undefined;
      }
    ).buildMessage(
      Notification.EXTENSION,
      extensionPayload,
      'friend@seerr.dev',
      'friend'
    );

    assert.ok(message, 'expected an email to be built');
    assert.match(message.template, /templates\/email\/extension$/);
    assert.strictEqual(message.locals.event, 'Watch Milestone');
    assert.strictEqual(message.locals.subject, 'You watched 100 things');
    assert.strictEqual(message.locals.body, 'Congratulations.');
  });
});

/**
 * Registers real agents on the shared `notificationManager`, which has no
 * removal API — so this runs last, after every test that asserts on dispatches.
 */
describe('delivery through the notification manager', () => {
  function recordingAgent(recorded: string[]): NotificationAgent {
    return {
      shouldSend: () => true,
      send: async (type, payload) => {
        recorded.push(`${Notification[type]}:${payload.subject}`);
        return true;
      },
    };
  }

  const explodingAgent: NotificationAgent = {
    shouldSend: () => true,
    send: () => {
      throw new Error('agent exploded');
    },
  };

  const rejectingAgent: NotificationAgent = {
    shouldSend: () => true,
    send: async () => {
      throw new Error('agent rejected');
    },
  };

  it('keeps delivering to the remaining subscribers when an agent throws', async () => {
    declare();
    const recorded: string[] = [];
    notificationManager.registerAgents([
      explodingAgent,
      rejectingAgent,
      recordingAgent(recorded),
    ]);

    const friend = await getUser('friend@seerr.dev');
    const admin = await getUser('admin@seerr.dev');
    await subscribeExtensionNotification(friend.id, 'watch-history:milestone');
    await subscribeExtensionNotification(admin.id, 'watch-history:milestone');

    await sendExtensionNotification('watch-history', 'milestone', {
      subject: 'Hello',
    });

    // Once for the system channels, once per subscriber.
    assert.deepStrictEqual(recorded, [
      'EXTENSION:Hello',
      'EXTENSION:Hello',
      'EXTENSION:Hello',
    ]);
  });
});

describe('GET|POST /user/:id/settings/extension-notifications', () => {
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    const email = req.header('x-test-user');

    if (email) {
      req.user = await getRepository(User).findOneOrFail({ where: { email } });
    }

    next();
  });
  app.use('/user', userRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );

  function as(email: string) {
    return { 'x-test-user': email };
  }

  it('reports the subscribed, effective and available notifications', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    await subscribeExtensionNotification(friend.id, 'watch-history:milestone', [
      NotificationAgentKey.EMAIL,
    ]);
    await subscribeExtensionNotification(friend.id, 'gone-away:event');

    const res = await request(app)
      .get(`/user/${friend.id}/settings/extension-notifications`)
      .set(as('friend@seerr.dev'));

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.subscriptions, [
      { notificationType: 'gone-away:event', agents: [] },
      {
        notificationType: 'watch-history:milestone',
        agents: [NotificationAgentKey.EMAIL],
      },
    ]);
    assert.deepStrictEqual(res.body.effective, ['watch-history:milestone']);
    assert.deepStrictEqual(
      res.body.available.map(
        (option: { notificationType: string; default: boolean }) => [
          option.notificationType,
          option.default,
        ]
      ),
      [
        ['watch-history:milestone', true],
        ['watch-history:digest', false],
        ['unrequest:removed', false],
      ]
    );
  });

  it('lets an admin read another user’s subscriptions', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    const res = await request(app)
      .get(`/user/${friend.id}/settings/extension-notifications`)
      .set(as('admin@seerr.dev'));

    assert.strictEqual(res.status, 200);
  });

  it('403s for another user’s subscriptions', async () => {
    declare();
    const other = await getRepository(User).save(
      new User({ email: 'other@seerr.dev', avatar: '', permissions: 32 })
    );

    const res = await request(app)
      .get(`/user/${other.id}/settings/extension-notifications`)
      .set(as('friend@seerr.dev'));

    assert.strictEqual(res.status, 403);
  });

  it('404s for a user that does not exist', async () => {
    declare();

    const res = await request(app)
      .get('/user/9999/settings/extension-notifications')
      .set(as('admin@seerr.dev'));

    assert.strictEqual(res.status, 404);
  });

  it('replaces the subscriptions', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');
    await subscribeExtensionNotification(friend.id, 'watch-history:milestone');

    const res = await request(app)
      .post(`/user/${friend.id}/settings/extension-notifications`)
      .set(as('friend@seerr.dev'))
      .send({
        subscriptions: [
          {
            notificationType: 'watch-history:digest',
            agents: [NotificationAgentKey.WEBPUSH],
          },
        ],
      });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.subscriptions, [
      {
        notificationType: 'watch-history:digest',
        agents: [NotificationAgentKey.WEBPUSH],
      },
    ]);
  });

  it('400s on a notification no installed extension declares', async () => {
    declare();
    const friend = await getUser('friend@seerr.dev');

    const res = await request(app)
      .post(`/user/${friend.id}/settings/extension-notifications`)
      .set(as('friend@seerr.dev'))
      .send({ subscriptions: [{ notificationType: 'nothing:at_all' }] });

    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(
      await getExtensionNotificationSubscriptions(friend.id),
      []
    );
  });

  it('refuses to modify the owner’s subscriptions', async () => {
    declare();
    await getRepository(User).save(
      new User({
        email: 'second-admin@seerr.dev',
        avatar: '',
        permissions: 2,
      })
    );

    const res = await request(app)
      .post('/user/1/settings/extension-notifications')
      .set(as('second-admin@seerr.dev'))
      .send({ subscriptions: [] });

    assert.strictEqual(res.status, 403);
  });

  it('declares nothing when no extension is installed', async () => {
    const friend = await getUser('friend@seerr.dev');

    const res = await request(app)
      .get(`/user/${friend.id}/settings/extension-notifications`)
      .set(as('friend@seerr.dev'));

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.available, []);
    assert.deepStrictEqual(getExtensionNotificationDeclarations(), []);
  });
});
