/**
 * Which extension notifications a user wants, and on which agents.
 *
 * Its own tab rather than rows inside the per-agent `NotificationTypeSelector`,
 * because an extension notification is not a bit in the mask those selectors edit.
 * Core carries a single `Notification.EXTENSION` sentinel meaning "extension
 * notifications, on this agent"; *which* events a user wants are rows in
 * `ext_notification_subscription`, keyed by the namespaced `<extensionId>:<key>`
 * string. That split exists so a user's persisted mask does not depend on which
 * extensions happen to be installed.
 *
 * The consequence worth stating in the UI: a subscription here delivers nothing
 * unless the sentinel is also on for the agent, which is why each per-agent
 * selector still shows an extension row.
 */
import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { Form, Formik } from 'formik';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.UserProfile.UserSettings.UserNotificationSettings',
  {
    extensionNotifications: 'Extension Notifications',
    extensionNotificationsDescription:
      'Notifications provided by installed extensions. These are stored separately from the types above, so they survive an extension being disabled or reinstalled.',
    noExtensionNotifications: 'No extensions provide any notification types.',
    agentsAllTip:
      'Delivered on every agent you have enabled. Extension notifications must also be switched on for that agent.',
    inertSubscription:
      'Subscribed, but the extension providing this is not currently loaded.',
    extensionsettingssaved:
      'Extension notification settings saved successfully!',
    extensionsettingsfailed: 'Extension notification settings failed to save.',
  }
);

/** Mirrors `ExtensionNotificationOption` in `seerr-api.yml`. */
interface ExtensionNotificationOption {
  notificationType: string;
  extensionId: string;
  name: string;
  description?: string;
  default: boolean;
}

interface ExtensionNotificationSubscription {
  notificationType: string;
  agents?: string[];
}

interface ExtensionNotificationsResponse {
  subscriptions: ExtensionNotificationSubscription[];
  effective: string[];
  available: ExtensionNotificationOption[];
}

const UserNotificationsExtensions = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const router = useRouter();
  const { user } = useUser({ id: Number(router.query.userId) });
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<ExtensionNotificationsResponse>(
    user ? `/api/v1/user/${user?.id}/settings/extension-notifications` : null
  );

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  const available = data?.available ?? [];
  const subscribed = new Set(
    (data?.subscriptions ?? []).map(
      (subscription) => subscription.notificationType
    )
  );
  const effective = new Set(data?.effective ?? []);

  const byExtension = available.reduce<
    Record<string, ExtensionNotificationOption[]>
  >((groups, option) => {
    (groups[option.extensionId] ??= []).push(option);
    return groups;
  }, {});

  /**
   * Subscriptions whose extension is no longer loaded. They are kept rather than
   * dropped — an extension being disabled or mid-reinstall should not silently
   * unsubscribe anyone — but they cannot be rendered as options, since nothing
   * declares a name for them. Listed so a stale subscription is visible rather
   * than merely absent.
   */
  const orphaned = [...subscribed].filter(
    (type) =>
      !available.some((option) => option.notificationType === type) &&
      !effective.has(type)
  );

  return (
    <>
      <div className="mb-6">
        <h3 className="heading">
          {intl.formatMessage(messages.extensionNotifications)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.extensionNotificationsDescription)}
        </p>
      </div>

      {!available.length && !orphaned.length ? (
        <Alert
          title={intl.formatMessage(messages.noExtensionNotifications)}
          type="info"
        />
      ) : (
        <Formik
          initialValues={{
            types: [...subscribed],
          }}
          enableReinitialize
          onSubmit={async (values) => {
            try {
              await axios.post(
                `/api/v1/user/${user?.id}/settings/extension-notifications`,
                {
                  // Agents are left empty, which the server reads as "every
                  // configured agent". Per-agent routing is a refinement the
                  // endpoint supports but nothing yet asks for; sending an empty
                  // list keeps this page from inventing a narrower default than
                  // the user chose.
                  subscriptions: values.types.map((notificationType) => ({
                    notificationType,
                    agents: [],
                  })),
                }
              );

              addToast(intl.formatMessage(messages.extensionsettingssaved), {
                autoDismiss: true,
                appearance: 'success',
              });
            } catch {
              addToast(intl.formatMessage(messages.extensionsettingsfailed), {
                autoDismiss: true,
                appearance: 'error',
              });
            } finally {
              revalidate();
            }
          }}
        >
          {({ isSubmitting, values, setFieldValue }) => {
            const toggle = (notificationType: string) => {
              setFieldValue(
                'types',
                values.types.includes(notificationType)
                  ? values.types.filter((type) => type !== notificationType)
                  : [...values.types, notificationType]
              );
            };

            return (
              <Form>
                {Object.entries(byExtension).map(([extensionId, options]) => (
                  <div key={`ext-notif-group-${extensionId}`} className="mb-6">
                    <h4 className="mb-2 font-mono text-sm text-gray-400">
                      {extensionId}
                    </h4>
                    {options.map((option) => (
                      <div
                        key={`ext-notif-${option.notificationType}`}
                        className="relative mt-4 flex items-start first:mt-0"
                      >
                        <div className="flex h-6 items-center">
                          <input
                            id={`ext-notif-${option.notificationType}`}
                            name="extensionNotifications"
                            type="checkbox"
                            checked={values.types.includes(
                              option.notificationType
                            )}
                            onChange={() => toggle(option.notificationType)}
                          />
                        </div>
                        <div className="ml-3 text-sm leading-6">
                          <label
                            htmlFor={`ext-notif-${option.notificationType}`}
                            className="block"
                            aria-label={option.name}
                          >
                            <div className="flex flex-col">
                              {/* Extension-authored, so rendered verbatim. */}
                              <span className="font-medium text-white">
                                {option.name}
                              </span>
                              {option.description && (
                                <span className="font-normal text-gray-400">
                                  {option.description}
                                </span>
                              )}
                              <span className="mt-1 text-xs text-gray-500">
                                {intl.formatMessage(messages.agentsAllTip)}
                              </span>
                            </div>
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}

                {!!orphaned.length && (
                  <div className="mb-6">
                    <Alert
                      title={intl.formatMessage(messages.inertSubscription)}
                      type="warning"
                    >
                      <ul className="list-inside list-disc font-mono text-xs">
                        {orphaned.map((type) => (
                          <li key={`ext-notif-orphan-${type}`}>{type}</li>
                        ))}
                      </ul>
                    </Alert>
                  </div>
                )}

                <div className="actions">
                  <div className="flex justify-end">
                    <span className="ml-3 inline-flex rounded-md shadow-sm">
                      <Button
                        buttonType="primary"
                        type="submit"
                        disabled={isSubmitting}
                      >
                        <ArrowDownOnSquareIcon />
                        <span>
                          {isSubmitting
                            ? intl.formatMessage(globalMessages.saving)
                            : intl.formatMessage(globalMessages.save)}
                        </span>
                      </Button>
                    </span>
                  </div>
                </div>
              </Form>
            );
          }}
        </Formik>
      )}
    </>
  );
};

export default UserNotificationsExtensions;
