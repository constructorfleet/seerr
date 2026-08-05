import { getRepository } from '@server/datasource';
import { ExtensionNotificationSubscription } from '@server/entity/ExtensionNotificationSubscription';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import {
  EXTENSION_ID_PATTERN,
  EXTENSION_KEY_PATTERN,
} from '@server/lib/extensions/manifest';
import type { ExtensionRegistry } from '@server/lib/extensions/registry';
import type { ExtensionNotificationPayload } from '@server/lib/extensions/types';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import { NotificationAgentKey } from '@server/lib/settings';
import logger from '@server/logger';
import type { EntityManager } from 'typeorm';
import { In } from 'typeorm';

/**
 * Separates an extension id from one of its local notification keys. Neither
 * `EXTENSION_ID_PATTERN` nor `EXTENSION_KEY_PATTERN` admits a colon, so a
 * namespaced type always splits back into exactly the two parts it was built
 * from. Deliberately the same separator as extension permissions use.
 */
const NAMESPACE_SEPARATOR = ':';

/** The agent keys a subscription may name, for validating client input. */
const agentKeys = new Set<string>(Object.values(NotificationAgentKey));

/**
 * One manifest notification, resolved: namespaced, with `default` defaulted.
 *
 * The sibling of `ExtensionPermissionDeclaration`, and for the same reason — the
 * manifest is the only description of what an extension contributes, and the
 * resolver must not have to re-read it.
 */
export interface ExtensionNotificationDeclaration {
  /** `<extensionId>:<key>`, as stored in `ext_notification_subscription`. */
  notificationType: string;
  extensionId: string;
  /** The manifest-local key, not namespaced. */
  key: string;
  name: string;
  description?: string;
  /** Subscribed for newly created users. */
  default: boolean;
}

/** A user's opt-in to one extension notification. */
export interface ExtensionNotificationSubscriptionOption {
  notificationType: string;
  /**
   * The agents to deliver on. Empty means every configured agent, which is what
   * core does for a user who never edited their notification settings.
   */
  agents: NotificationAgentKey[];
}

/**
 * Where the declared notifications come from.
 *
 * Injected rather than read from a module-global registry so this module has no
 * boot-order dependency, exactly as the permission resolver does it: boot points
 * it at the real registry, tests point it at a literal list. Defaults to none,
 * which makes every extension notification type an inert string — the correct
 * behaviour with nothing installed.
 */
type DeclarationProvider = () => ExtensionNotificationDeclaration[];

let provideDeclarations: DeclarationProvider = () => [];

// #region namespacing

/**
 * `('watch-history', 'milestone')` → `'watch-history:milestone'`.
 *
 * @throws when either part is invalid. The result is written to the database and
 * compared against manifest declarations, so an unvalidated part would produce a
 * subscription that can be stored but never matched.
 */
export function buildExtensionNotificationType(
  extensionId: string,
  key: string
): string {
  if (!EXTENSION_ID_PATTERN.test(extensionId)) {
    throw new Error(`"${extensionId}" is not a valid extension id`);
  }

  if (!EXTENSION_KEY_PATTERN.test(key)) {
    throw new Error(`"${key}" is not a valid extension notification key`);
  }

  return `${extensionId}${NAMESPACE_SEPARATOR}${key}`;
}

/**
 * The inverse of {@link buildExtensionNotificationType}, or `undefined` if
 * `value` is not a namespaced extension notification type — which is how core
 * `Notification` member names and stray strings are told apart from extension
 * keys.
 */
export function parseExtensionNotificationType(
  value: string
): { extensionId: string; key: string } | undefined {
  const parts = value.split(NAMESPACE_SEPARATOR);

  if (parts.length !== 2) {
    return undefined;
  }

  const [extensionId, key] = parts;

  if (!EXTENSION_ID_PATTERN.test(extensionId)) {
    return undefined;
  }

  if (!EXTENSION_KEY_PATTERN.test(key)) {
    return undefined;
  }

  return { extensionId, key };
}

/** Whether `value` is shaped like `<extensionId>:<key>`. */
export function isExtensionNotificationType(value: string): boolean {
  return parseExtensionNotificationType(value) !== undefined;
}

// #endregion

// #region declarations

/**
 * Points the resolver at a set of declarations. Call at boot with the registry
 * (see {@link setExtensionNotificationRegistry}).
 */
export function setExtensionNotificationDeclarations(
  provider: DeclarationProvider
): void {
  provideDeclarations = provider;
}

/** Wires the resolver to a live registry, for `activateDiscoveredExtensions`. */
export function setExtensionNotificationRegistry(
  registry: ExtensionRegistry
): void {
  setExtensionNotificationDeclarations(() =>
    declarationsFromRegistry(registry)
  );
}

/** Every notification the installed, non-quarantined extensions declare. */
export function getExtensionNotificationDeclarations(): ExtensionNotificationDeclaration[] {
  return provideDeclarations();
}

/**
 * Resolves the manifest notifications of every extension that is loaded and not
 * quarantined.
 *
 * A `failed` or `disabled` extension contributes nothing, so its notifications
 * stop being deliverable while its subscription rows stay on disk: uninstalling
 * and reinstalling an extension restores what its users had opted into, which is
 * the point of string keys over recycled bits.
 */
export function declarationsFromRegistry(
  registry: ExtensionRegistry
): ExtensionNotificationDeclaration[] {
  return registry
    .all()
    .filter((entry) => entry.status === 'pending' || entry.status === 'active')
    .flatMap((entry) =>
      (entry.manifest?.provides?.notifications ?? []).map((declared) => ({
        notificationType: buildExtensionNotificationType(
          entry.id,
          declared.key
        ),
        extensionId: entry.id,
        key: declared.key,
        name: declared.name,
        ...(declared.description ? { description: declared.description } : {}),
        default: declared.default ?? false,
      }))
    );
}

/**
 * The declarations keyed by namespaced type.
 *
 * Built once per query rather than looked up per type: the registry-backed
 * provider re-derives its list on every call, so a per-type lookup would rebuild
 * it once for each type a caller asks about.
 */
function declarationMap(): Map<string, ExtensionNotificationDeclaration> {
  return new Map(
    provideDeclarations().map((declaration) => [
      declaration.notificationType,
      declaration,
    ])
  );
}

// #endregion

// #region queries

/**
 * A user's subscriptions, as stored — including ones for extensions that are not
 * currently loaded.
 *
 * This is the editable state a notification editor binds to; it must show the box
 * a user ticked even while the extension that declared it is uninstalled.
 * {@link getEffectiveExtensionNotifications} is the resolved view.
 */
export async function getExtensionNotificationSubscriptions(
  userId: number
): Promise<ExtensionNotificationSubscriptionOption[]> {
  const rows = await getRepository(ExtensionNotificationSubscription).find({
    where: { userId },
    select: { notificationType: true, agents: true },
  });

  return rows
    .map((row) => ({
      notificationType: row.notificationType,
      agents: row.agents ?? [],
    }))
    .sort((a, b) => a.notificationType.localeCompare(b.notificationType));
}

/**
 * The subscriptions that currently deliver: the stored ones a loaded extension
 * still declares.
 *
 * One query, and the declarations resolved once, so the client gets the whole
 * view without a request per type.
 */
export async function getEffectiveExtensionNotifications(
  userId: number
): Promise<string[]> {
  const declared = declarationMap();

  return (await getExtensionNotificationSubscriptions(userId))
    .map((subscription) => subscription.notificationType)
    .filter((notificationType) => declared.has(notificationType));
}

/**
 * Every user subscribed to `notificationType`, with their settings, in one
 * query.
 *
 * A join rather than a row read followed by a `findOne` per user: an extension
 * that notifies on a schedule can have every user subscribed, and the send path
 * must not issue a query per recipient.
 */
async function findSubscribers(notificationType: string): Promise<
  {
    user: User;
    agents: NotificationAgentKey[];
  }[]
> {
  const rows = await getRepository(ExtensionNotificationSubscription).find({
    where: { notificationType },
    relations: { user: true },
  });

  return rows
    .filter((row): row is typeof row & { user: User } => !!row.user)
    .map((row) => ({ user: row.user, agents: row.agents ?? [] }))
    .sort((a, b) => a.user.id - b.user.id);
}

// #endregion

// #region mutation

/**
 * Subscribes a user to one or more namespaced types, idempotently.
 *
 * @throws when a type is not namespaced. Rows are matched against manifest
 * declarations by exact string, so a bare `milestone` would be storable and never
 * matchable.
 */
export async function subscribeExtensionNotification(
  userId: number,
  notificationType: string | string[],
  agents: NotificationAgentKey[] = [],
  manager?: EntityManager
): Promise<void> {
  const types = assertNamespaced(notificationType);

  if (!types.length) {
    return;
  }

  const repository = manager
    ? manager.getRepository(ExtensionNotificationSubscription)
    : getRepository(ExtensionNotificationSubscription);

  await repository.save(
    types.map(
      (type) =>
        new ExtensionNotificationSubscription({
          userId,
          notificationType: type,
          agents,
        })
    )
  );
}

/** Unsubscribes a user. Unsubscribing from one not held is a no-op. */
export async function unsubscribeExtensionNotification(
  userId: number,
  notificationType: string | string[]
): Promise<void> {
  const types = Array.isArray(notificationType)
    ? notificationType
    : [notificationType];

  if (!types.length) {
    return;
  }

  await getRepository(ExtensionNotificationSubscription).delete({
    userId,
    notificationType: In(types),
  });
}

/**
 * Replaces a user's subscriptions with exactly `subscriptions`.
 *
 * Only types a loaded extension declares may be set: a caller cannot write a row
 * for an extension that is not installed, which would otherwise start delivering
 * the moment one was.
 */
export async function setExtensionNotificationSubscriptions(
  userId: number,
  subscriptions: {
    notificationType: string;
    agents?: NotificationAgentKey[];
  }[]
): Promise<void> {
  const declared = declarationMap();
  const undeclared = subscriptions.filter(
    (subscription) => !declared.has(subscription.notificationType)
  );

  if (undeclared.length) {
    throw new Error(
      `No installed extension declares ${undeclared
        .map((subscription) => `"${subscription.notificationType}"`)
        .join(', ')}`
    );
  }

  const unknownAgents = subscriptions.flatMap((subscription) =>
    (subscription.agents ?? []).filter((agent) => !agentKeys.has(agent))
  );

  if (unknownAgents.length) {
    throw new Error(
      `Unknown notification ${
        unknownAgents.length === 1 ? 'agent' : 'agents'
      } ${unknownAgents.map((agent) => `"${agent}"`).join(', ')}`
    );
  }

  const current = await getExtensionNotificationSubscriptions(userId);
  const wanted = new Set(
    subscriptions.map((subscription) => subscription.notificationType)
  );

  // Only the declared rows are replaced. A row for an uninstalled extension is
  // not something the client could have submitted, so treating its absence as a
  // deletion would quietly discard an opt-in the user still holds.
  await unsubscribeExtensionNotification(
    userId,
    current
      .filter(
        (subscription) =>
          declared.has(subscription.notificationType) &&
          !wanted.has(subscription.notificationType)
      )
      .map((subscription) => subscription.notificationType)
  );

  const repository = getRepository(ExtensionNotificationSubscription);

  if (subscriptions.length) {
    await repository.save(
      subscriptions.map(
        (subscription) =>
          new ExtensionNotificationSubscription({
            userId,
            notificationType: subscription.notificationType,
            agents: subscription.agents ?? [],
          })
      )
    );
  }
}

/**
 * Subscribes a newly created user to the `default: true` types, mirroring what
 * `settings.main.defaultPermissions` does for the core bitmask. Called from
 * `ExtensionNotificationSubscriber` so every path that creates a user — local,
 * Plex and Jellyfin sign-in, and the admin's create-user form — is covered
 * without touching core's notification settings.
 */
export async function subscribeDefaultExtensionNotifications(
  userId: number,
  manager?: EntityManager
): Promise<void> {
  const defaults = provideDeclarations()
    .filter((declaration) => declaration.default)
    .map((declaration) => declaration.notificationType);

  if (!defaults.length) {
    return;
  }

  await subscribeExtensionNotification(userId, defaults, [], manager);
}

function assertNamespaced(notificationType: string | string[]): string[] {
  const types = Array.isArray(notificationType)
    ? notificationType
    : [notificationType];

  for (const value of types) {
    if (!isExtensionNotificationType(value)) {
      throw new Error(
        `"${value}" is not a namespaced extension notification type (<extensionId>:<key>)`
      );
    }
  }

  return types;
}

// #endregion

// #region delivery

/**
 * Backs `sdk.notify.send`: resolves who opted into `<extensionId>:<key>` and
 * dispatches through `notificationManager`, so an extension notification reaches
 * every configured agent with no per-agent code.
 *
 * One dispatch for the system channels (the operator's own Discord webhook,
 * Gotify, …, each gated on its configured `types` mask) plus one per subscriber,
 * because `NotificationPayload.notifyUser` is a single user and the per-user
 * agents read their credentials off it.
 *
 * @throws when the extension does not declare `key`. Sending an undeclared
 * notification is a bug in the extension, and the manifest is what the
 * subscription UI is built from — silently delivering something nobody can
 * unsubscribe from would be worse than a rejected promise the extension sees.
 */
export async function sendExtensionNotification(
  extensionId: string,
  key: string,
  payload: ExtensionNotificationPayload
): Promise<void> {
  const notificationType = buildExtensionNotificationType(extensionId, key);
  const declaration = declarationMap().get(notificationType);

  if (!declaration) {
    throw new Error(
      `No installed extension declares the notification "${notificationType}"`
    );
  }

  const base: NotificationPayload = {
    // What the agents that already render generically show as the event label.
    event: declaration.name,
    subject: payload.subject,
    ...(payload.message !== undefined ? { message: payload.message } : {}),
    ...(payload.image !== undefined ? { image: payload.image } : {}),
    ...(payload.extra ? { extra: payload.extra } : {}),
    ...(payload.media ? { media: payload.media } : {}),
    notifySystem: true,
    // Extension notifications are opted into by row, never inferred from a core
    // permission, so the admin fan-out in each agent must stay switched off.
    notifyAdmin: false,
    extensionEvent: {
      id: declaration.extensionId,
      key: declaration.key,
      name: declaration.name,
    },
  };

  logger.debug('Sending an extension notification', {
    label: 'Extensions',
    extensionId,
    notificationType,
    subject: payload.subject,
  });

  // Once for the operator's system channels, with no recipient.
  notificationManager.sendNotification(Notification.EXTENSION, base);

  const subscribers = await findSubscribers(notificationType);
  // An extension that named a recipient gets only that recipient, and only if
  // they subscribed: `notifyUser` narrows the audience, it does not bypass opt-in.
  const recipients = payload.notifyUser
    ? subscribers.filter(
        (subscriber) => subscriber.user.id === payload.notifyUser?.id
      )
    : subscribers;

  for (const { user, agents } of recipients) {
    notificationManager.sendNotification(Notification.EXTENSION, {
      ...base,
      notifySystem: false,
      notifyUser: withExtensionAgents(user, agents),
    });
  }
}

/**
 * The recipient with `Notification.EXTENSION` left on only for the agents this
 * subscription may deliver to.
 *
 * Every per-user agent gates on
 * `notifyUser.settings.hasNotificationType(<agent>, type)`, which reads the
 * persisted bitmask. The sentinel **is** in that mask: every per-agent
 * `NotificationTypeSelector` renders an Extension row, so a user can switch
 * extension notifications on or off per channel exactly as they do a core type,
 * and `ALL_NOTIFICATIONS` — the default for an unsaved mask, i.e. email and web
 * push — includes it.
 *
 * The two controls compose rather than override: the per-agent bit is the user's
 * channel opt-in, and the subscription's `agents` list narrows it further. So this
 * only ever *clears* the sentinel — for the agents the subscription did not name.
 * A user who cleared the row for an agent gets nothing there, whatever the
 * subscription says; a user who never touched it inherits the same default core
 * types get.
 *
 * The result is never saved. The clone exists so the narrowing cannot reach the
 * row: writing this dispatch's mask into `user_settings.notificationTypes` would
 * turn a per-event opt-in into a persisted per-channel change.
 */
function withExtensionAgents(user: User, agents: NotificationAgentKey[]): User {
  // No agents named — which is what the Extensions tab posts — means "every agent
  // I already allow extension notifications on", so nothing is narrowed.
  const enabled = agents.length ? agents : Object.values(NotificationAgentKey);
  const notificationTypes = { ...(user.settings?.notificationTypes ?? {}) };

  for (const agent of Object.values(NotificationAgentKey)) {
    if (enabled.includes(agent)) {
      continue;
    }

    notificationTypes[agent] =
      (notificationTypes[agent] ?? 0) & ~Notification.EXTENSION;
  }

  const clone = new User({ ...user });
  clone.settings = new UserSettings({
    ...(user.settings ?? {}),
    notificationTypes,
  });
  clone.setDisplayName();

  return clone;
}

// #endregion
