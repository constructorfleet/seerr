/**
 * The extension management page: what is installed, what state it reached at boot,
 * and install / enable / disable / uninstall.
 *
 * Every mutation here **requires a restart to take effect**, and the UI says so
 * rather than hiding it. That is not a limitation of this page: extension entities
 * must be registered before `dataSource.initialize()`, so nothing can begin or stop
 * running mid-process. A page that optimistically showed an extension as `active`
 * after installing it would be lying, so a freshly installed extension is reported
 * `pending` by the server and rendered as such.
 */
import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowDownTrayIcon,
  Cog6ToothIcon,
  PuzzlePieceIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import Link from 'next/link';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.SettingsExtensions', {
  extensions: 'Extensions',
  extensionsDescription:
    'Install and manage extensions. Extensions run as part of Seerr with the access their manifest declares, so only install ones you trust.',
  installedExtensions: 'Installed Extensions',
  noExtensions: 'No extensions installed.',
  noExtensionsDescription:
    'Install one from an npm package name or a git repository URL.',
  install: 'Install',
  installing: 'Installing…',
  source: 'Package Name or Git URL',
  sourcePlaceholder: 'seerr-extension-watch-history',
  sourceRequired: 'You must provide a package name or git URL.',
  configure: 'Configure',
  enable: 'Enable',
  disable: 'Disable',
  uninstall: 'Uninstall',
  uninstallConfirm: 'Are you sure?',
  purgeData: 'Also delete this extension’s permissions and subscriptions',
  purgeDataTip:
    'By default these are kept, so reinstalling restores who could use the extension and who heard from it.',
  restartRequired: 'Restart Seerr to apply',
  restartRequiredDescription:
    'Extensions are loaded at startup, so installing, enabling or disabling one takes effect on the next restart.',
  statusActive: 'Active',
  statusPending: 'Pending Restart',
  statusFailed: 'Failed',
  statusDisabled: 'Disabled',
  disabledByOperator: 'Switched off',
  toastInstallSuccess: '{name} installed. Restart Seerr to load it.',
  toastInstallFailure: 'Install failed: {message}',
  toastUninstallSuccess: '{id} uninstalled.',
  toastUninstallFailure: 'Uninstall failed: {message}',
  toastEnableSuccess: '{id} will load on the next restart.',
  toastDisableSuccess: '{id} will not load on the next restart.',
  toastToggleFailure: 'Something went wrong: {message}',
  unknownVersion: 'unknown version',
});

/** Mirrors the `ExtensionStatus` schema in `seerr-api.yml`. */
interface ExtensionStatus {
  id: string;
  name?: string;
  version?: string;
  status: 'pending' | 'active' | 'failed' | 'disabled';
  error?: string;
  enabled: boolean;
}

const InstallSchema = Yup.object().shape({
  source: Yup.string().required('sourceRequired'),
});

/** The message and badge colour for each status the server can report. */
const STATUS_DISPLAY: Record<
  ExtensionStatus['status'],
  {
    badgeType: 'success' | 'warning' | 'danger' | 'default';
    messageKey: keyof typeof messages;
  }
> = {
  active: { badgeType: 'success', messageKey: 'statusActive' },
  pending: { badgeType: 'warning', messageKey: 'statusPending' },
  failed: { badgeType: 'danger', messageKey: 'statusFailed' },
  disabled: { badgeType: 'default', messageKey: 'statusDisabled' },
};

const errorMessage = (e: unknown): string => {
  if (axios.isAxiosError(e)) {
    // The installer writes these, not extension code, so they are safe to show
    // and are the useful part of the failure.
    const message = (e.response?.data as { message?: string } | undefined)
      ?.message;

    if (message) {
      return message;
    }
  }

  return e instanceof Error ? e.message : String(e);
};

const SettingsExtensions = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const {
    data: extensions,
    error,
    mutate: revalidate,
  } = useSWR<ExtensionStatus[]>('/api/v1/settings/extensions');
  const [purgeData, setPurgeData] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState<string>();

  if (!extensions && !error) {
    return <LoadingSpinner />;
  }

  const toggle = async (extension: ExtensionStatus) => {
    const action = extension.enabled ? 'disable' : 'enable';

    setBusyId(extension.id);

    try {
      await axios.post(`/api/v1/settings/extensions/${extension.id}/${action}`);

      addToast(
        intl.formatMessage(
          action === 'enable'
            ? messages.toastEnableSuccess
            : messages.toastDisableSuccess,
          { id: extension.id }
        ),
        { autoDismiss: true, appearance: 'success' }
      );
    } catch (e) {
      addToast(
        intl.formatMessage(messages.toastToggleFailure, {
          message: errorMessage(e),
        }),
        { autoDismiss: true, appearance: 'error' }
      );
    } finally {
      setBusyId(undefined);
      revalidate();
    }
  };

  const uninstall = async (extension: ExtensionStatus) => {
    setBusyId(extension.id);

    try {
      await axios.delete(`/api/v1/settings/extensions/${extension.id}`, {
        params: { purgeData: purgeData[extension.id] ? 'true' : 'false' },
      });

      addToast(
        intl.formatMessage(messages.toastUninstallSuccess, {
          id: extension.id,
        }),
        { autoDismiss: true, appearance: 'success' }
      );
    } catch (e) {
      addToast(
        intl.formatMessage(messages.toastUninstallFailure, {
          message: errorMessage(e),
        }),
        { autoDismiss: true, appearance: 'error' }
      );
    } finally {
      setBusyId(undefined);
      revalidate();
    }
  };

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.extensions),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.extensions)}</h3>
        <p className="description">
          {intl.formatMessage(messages.extensionsDescription)}
        </p>
      </div>

      <Formik
        initialValues={{ source: '' }}
        validationSchema={InstallSchema}
        onSubmit={async (values, { resetForm }) => {
          try {
            const res = await axios.post<{ name: string }>(
              '/api/v1/settings/extensions',
              { source: values.source.trim() }
            );

            addToast(
              intl.formatMessage(messages.toastInstallSuccess, {
                name: res.data.name,
              }),
              { autoDismiss: true, appearance: 'success' }
            );
            resetForm();
          } catch (e) {
            addToast(
              intl.formatMessage(messages.toastInstallFailure, {
                message: errorMessage(e),
              }),
              { appearance: 'error' }
            );
          } finally {
            revalidate();
          }
        }}
      >
        {({ errors, touched, isSubmitting, isValid }) => (
          <Form className="section">
            <div className="form-row">
              <label htmlFor="source" className="text-label">
                {intl.formatMessage(messages.source)}
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    id="source"
                    name="source"
                    type="text"
                    placeholder={intl.formatMessage(messages.sourcePlaceholder)}
                  />
                </div>
                {errors.source && touched.source && (
                  <div className="error">
                    {intl.formatMessage(messages.sourceRequired)}
                  </div>
                )}
              </div>
            </div>
            <div className="actions">
              <div className="flex justify-end">
                <Button
                  buttonType="primary"
                  type="submit"
                  disabled={isSubmitting || !isValid}
                >
                  <ArrowDownTrayIcon />
                  <span>
                    {isSubmitting
                      ? intl.formatMessage(messages.installing)
                      : intl.formatMessage(messages.install)}
                  </span>
                </Button>
              </div>
            </div>
          </Form>
        )}
      </Formik>

      <div className="mb-6 mt-10">
        <h3 className="heading">
          {intl.formatMessage(messages.installedExtensions)}
        </h3>
      </div>

      {!extensions?.length ? (
        <Alert title={intl.formatMessage(messages.noExtensions)} type="info">
          {intl.formatMessage(messages.noExtensionsDescription)}
        </Alert>
      ) : (
        <ul className="space-y-4">
          {extensions.map((extension) => {
            const display = STATUS_DISPLAY[extension.status];
            const busy = busyId === extension.id;

            return (
              <li
                key={extension.id}
                className="rounded-lg bg-gray-800 p-4 shadow ring-1 ring-gray-700"
              >
                <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <PuzzlePieceIcon className="h-5 w-5 flex-shrink-0 text-gray-400" />
                      {/* Extension-authored, so rendered verbatim and never
                          translated. Falls back to the id, which is all there is
                          when the manifest itself is what failed to parse. */}
                      <span className="truncate text-lg font-semibold text-white">
                        {extension.name ?? extension.id}
                      </span>
                      <Badge badgeType={display.badgeType}>
                        {intl.formatMessage(messages[display.messageKey])}
                      </Badge>
                      {/* `enabled` is independent of `status`, so that "switched
                          off" and "broken" stay distinguishable. */}
                      {!extension.enabled &&
                        extension.status !== 'disabled' && (
                          <Badge badgeType="default">
                            {intl.formatMessage(messages.disabledByOperator)}
                          </Badge>
                        )}
                    </div>
                    <div className="mt-1 text-sm text-gray-400">
                      <span className="font-mono">{extension.id}</span>
                      {' · '}
                      {extension.version ??
                        intl.formatMessage(messages.unknownVersion)}
                    </div>
                    {extension.error && (
                      <div className="mt-3">
                        <Alert
                          title={intl.formatMessage(messages.statusFailed)}
                          type="error"
                        >
                          {extension.error}
                        </Alert>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-shrink-0 flex-col items-stretch gap-2 sm:items-end">
                    <div className="flex gap-2">
                      {/* A link rather than a button, so the row is navigable
                          without JavaScript having to route it. Shown for every
                          extension including a failed one: its saved settings and
                          grants are still there to inspect. */}
                      <Link
                        href={`/settings/extensions/${extension.id}`}
                        className="button-md inline-flex items-center rounded-md border border-gray-500 bg-gray-800 px-4 py-2 text-sm font-medium !text-white !no-underline transition hover:bg-gray-700"
                      >
                        {/* Sized by `.button-md`'s own svg rule, matching the
                            real buttons beside it. */}
                        <Cog6ToothIcon />
                        <span>{intl.formatMessage(messages.configure)}</span>
                      </Link>
                      <Button
                        buttonType="default"
                        disabled={busy}
                        onClick={() => toggle(extension)}
                      >
                        <span>
                          {intl.formatMessage(
                            extension.enabled
                              ? messages.disable
                              : messages.enable
                          )}
                        </span>
                      </Button>
                      <ConfirmButton
                        onClick={() => uninstall(extension)}
                        confirmText={intl.formatMessage(
                          messages.uninstallConfirm
                        )}
                      >
                        <TrashIcon />
                        <span>{intl.formatMessage(messages.uninstall)}</span>
                      </ConfirmButton>
                    </div>
                    {/* Beside the uninstall button rather than in the card body,
                        since it modifies only that action. Default off: these rows
                        record the operator's decisions about users, not extension
                        data, so a reinstall restores who could use the extension
                        and who heard from it. */}
                    <label className="flex items-start gap-2 text-sm text-gray-400 sm:max-w-xs">
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-gray-600 bg-gray-700 text-indigo-600"
                        checked={!!purgeData[extension.id]}
                        onChange={(e) =>
                          setPurgeData((current) => ({
                            ...current,
                            [extension.id]: e.target.checked,
                          }))
                        }
                      />
                      <span>
                        {intl.formatMessage(messages.purgeData)}
                        <span className="block text-xs text-gray-500">
                          {intl.formatMessage(messages.purgeDataTip)}
                        </span>
                      </span>
                    </label>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!!extensions?.length && (
        <div className="mt-6">
          <Alert
            title={intl.formatMessage(messages.restartRequired)}
            type="info"
          >
            {intl.formatMessage(messages.restartRequiredDescription)}
          </Alert>
        </div>
      )}
    </>
  );
};

export default SettingsExtensions;
