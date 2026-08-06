/**
 * The admin shell for one extension: its identity and boot status, then a tab per
 * thing an operator can configure about it.
 *
 * A dedicated page per extension rather than a section on the extension list,
 * because both tabs are driven by what the extension *declares* — its settings
 * schema and its permissions — and an extension can declare a lot of either. The
 * list stays a list.
 */
import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import ExtensionIcon from '@app/components/Common/ExtensionIcon';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import type { SettingsRoute } from '@app/components/Common/SettingsTabs';
import SettingsTabs from '@app/components/Common/SettingsTabs';
import ExtensionPermissionMatrix from '@app/components/Settings/SettingsExtension/ExtensionPermissionMatrix';
import ExtensionSettingsForm from '@app/components/Settings/SettingsExtension/ExtensionSettingsForm';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowLeftIcon } from '@heroicons/react/24/outline';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.SettingsExtension', {
  extensions: 'Extensions',
  settings: 'Settings',
  permissions: 'Permissions',
  backToExtensions: 'All extensions',
  notInstalled: 'No such extension',
  notInstalledDescription:
    'Nothing is installed under this id. It may have been uninstalled from another session.',
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
  /**
   * The heroicon the extension declared for its sidebar link, reported by the
   * server so this page draws the same extension the sidebar draws. Absent when it
   * declared none, which is the one case a puzzle piece is the truth.
   */
  icon?: string;
}

const STATUS_BADGE: Record<
  ExtensionStatus['status'],
  'success' | 'warning' | 'danger' | 'default'
> = {
  active: 'success',
  pending: 'warning',
  failed: 'danger',
  disabled: 'default',
};

const SettingsExtension = ({ tab }: { tab: 'settings' | 'permissions' }) => {
  const intl = useIntl();
  const router = useRouter();
  const extensionId = String(router.query.extensionId ?? '');
  const { data, error } = useSWR<ExtensionStatus[]>(
    '/api/v1/settings/extensions'
  );

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  const extension = data?.find((entry) => entry.id === extensionId);

  if (!extension) {
    return (
      <Alert title={intl.formatMessage(messages.notInstalled)} type="error">
        {intl.formatMessage(messages.notInstalledDescription)}
      </Alert>
    );
  }

  // Only an `active` extension has been `require`d, so only an active one has
  // registered its declarations. Both tabs need to say so rather than rendering an
  // empty form that looks like "this extension configures nothing".
  const isLoaded = extension.status === 'active';

  // Matched against `router.pathname`, which keeps Next's literal `[extensionId]`
  // segment — the interpolated id goes in `route`, which is what gets navigated to.
  const settingsRoutes: SettingsRoute[] = [
    {
      text: intl.formatMessage(messages.settings),
      route: `/settings/extensions/${extensionId}`,
      regex: /^\/settings\/extensions\/\[extensionId\]$/,
    },
    {
      text: intl.formatMessage(messages.permissions),
      route: `/settings/extensions/${extensionId}/permissions`,
      regex: /^\/settings\/extensions\/\[extensionId\]\/permissions/,
    },
  ];

  return (
    <>
      <PageTitle
        title={[
          extension.name ?? extension.id,
          intl.formatMessage(messages.extensions),
          intl.formatMessage(globalMessages.settings),
        ]}
      />

      <Link
        href="/settings/extensions"
        className="mb-4 inline-flex items-center text-sm text-gray-400 transition hover:text-gray-200"
      >
        <ArrowLeftIcon className="mr-1 h-4 w-4" />
        {intl.formatMessage(messages.backToExtensions)}
      </Link>

      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-2">
          <ExtensionIcon
            name={extension.icon}
            className="h-5 w-5 flex-shrink-0 text-gray-400"
          />
          {/* Extension-authored, so rendered verbatim and never translated. */}
          <h3 className="heading !mb-0">{extension.name ?? extension.id}</h3>
          <Badge badgeType={STATUS_BADGE[extension.status]}>
            {extension.status}
          </Badge>
        </div>
        <p className="description">
          <span className="font-mono">{extension.id}</span>
          {' · '}
          {extension.version ?? intl.formatMessage(messages.unknownVersion)}
        </p>
      </div>

      {/* No "not running" banner here: each tab says it, and says it only when
          that tab actually has nothing to show. A shell-level one would repeat
          itself under a tab that still has content to render. */}
      <SettingsTabs settingsRoutes={settingsRoutes} />

      <div className="mt-6">
        {tab === 'settings' ? (
          <ExtensionSettingsForm
            extensionId={extensionId}
            isLoaded={isLoaded}
          />
        ) : (
          <ExtensionPermissionMatrix
            extensionId={extensionId}
            isLoaded={isLoaded}
          />
        )}
      </div>
    </>
  );
};

export default SettingsExtension;
