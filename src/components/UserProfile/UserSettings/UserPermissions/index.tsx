import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import type { ExtensionPermissionOption } from '@app/components/ExtensionPermissionEdit';
import ExtensionPermissionEdit from '@app/components/ExtensionPermissionEdit';
import PermissionEdit from '@app/components/PermissionEdit';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import { hasPermission } from '@server/lib/permissions';
import axios from 'axios';
import { Form, Formik } from 'formik';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.UserProfile.UserSettings.UserPermissions',
  {
    toastSettingsSuccess: 'Permissions saved successfully!',
    toastSettingsFailure: 'Something went wrong while saving settings.',
    permissions: 'Permissions',
    unauthorizedDescription: 'You cannot modify your own permissions.',
    toastExtensionFailure:
      'Core permissions were saved, but the extension permissions were not.',
  }
);

const UserPermissions = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const router = useRouter();
  const { user: currentUser } = useUser();
  const { user, revalidate: revalidateUser } = useUser({
    id: Number(router.query.userId),
  });
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<{ permissions?: number }>(
    user ? `/api/v1/user/${user?.id}/settings/permissions` : null
  );
  /**
   * Extension permissions come from their own endpoint and save to their own
   * endpoint: they are rows keyed by a namespaced string, not bits in the integer
   * above. Absent data is treated as "no extensions declare any", which is also
   * what an install with no extensions looks like.
   */
  const { data: extensionData, mutate: revalidateExtensions } = useSWR<{
    permissions: string[];
    effective: string[];
    available: ExtensionPermissionOption[];
  }>(user ? `/api/v1/user/${user?.id}/settings/extension-permissions` : null);

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <ErrorPage statusCode={500} />;
  }

  if (currentUser?.id !== 1 && currentUser?.id === user?.id) {
    return (
      <>
        <div className="mb-6">
          <h3 className="heading">
            {intl.formatMessage(messages.permissions)}
          </h3>
        </div>
        <Alert
          title={intl.formatMessage(messages.unauthorizedDescription)}
          type="error"
        />
      </>
    );
  }

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.permissions),
          intl.formatMessage(globalMessages.usersettings),
          user?.displayName,
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.permissions)}</h3>
      </div>
      <Formik
        initialValues={{
          currentPermissions: data?.permissions,
          extensionPermissions: extensionData?.permissions ?? [],
        }}
        enableReinitialize
        onSubmit={async (values) => {
          try {
            await axios.post(`/api/v1/user/${user?.id}/settings/permissions`, {
              permissions: values.currentPermissions ?? 0,
            });

            // A second request, because extension permissions are rows rather
            // than bits and have their own endpoint. Sent after the core save so
            // that a failure here cannot cost the core change; reported
            // distinctly, since "some of what you just did was saved" is not the
            // same outcome as an outright failure.
            if (extensionData) {
              try {
                await axios.post(
                  `/api/v1/user/${user?.id}/settings/extension-permissions`,
                  { permissions: values.extensionPermissions }
                );
              } catch {
                addToast(intl.formatMessage(messages.toastExtensionFailure), {
                  appearance: 'error',
                });
                return;
              }
            }

            addToast(intl.formatMessage(messages.toastSettingsSuccess), {
              autoDismiss: true,
              appearance: 'success',
            });
          } catch {
            addToast(intl.formatMessage(messages.toastSettingsFailure), {
              autoDismiss: true,
              appearance: 'error',
            });
          } finally {
            revalidate();
            revalidateExtensions();
            revalidateUser();
          }
        }}
      >
        {({ isSubmitting, setFieldValue, values }) => {
          return (
            <Form className="section">
              <div className="max-w-3xl">
                <PermissionEdit
                  actingUser={currentUser}
                  currentUser={user}
                  currentPermission={values.currentPermissions ?? 0}
                  onUpdate={(newPermission) =>
                    setFieldValue('currentPermissions', newPermission)
                  }
                />
                {extensionData && (
                  <ExtensionPermissionEdit
                    available={extensionData.available}
                    granted={values.extensionPermissions}
                    effective={extensionData.effective}
                    isAdmin={hasPermission(
                      Permission.ADMIN,
                      values.currentPermissions ?? 0
                    )}
                    disabled={currentUser?.id !== 1 && user?.id === 1}
                    onUpdate={(granted) =>
                      setFieldValue('extensionPermissions', granted)
                    }
                  />
                )}
              </div>
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
    </>
  );
};

export default UserPermissions;
