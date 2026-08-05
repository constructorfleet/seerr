/**
 * The per-extension permission grant matrix.
 *
 * Complements the per-user editor in `ExtensionPermissionEdit` rather than
 * replacing it: that one answers "what may this user do", this one answers "who
 * may use this extension". Granting one permission across twenty users through
 * the per-user editor means twenty page visits, which is the gap this closes.
 *
 * Each cell writes only the one permission it names. The matrix is never told
 * about any other extension, so a write that replaced a user's whole declared set
 * would silently drop their grants elsewhere.
 *
 * Two states are shown that a plain checkbox cannot express: an admin holds every
 * permission through the `ADMIN` short-circuit with no row behind it, so there is
 * nothing to revoke; and a grant whose `requiresCore` is unmet exists but does
 * nothing, because `requiresCore` is enforced when the permission is checked
 * rather than when it is granted.
 */
import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.Settings.SettingsExtension.ExtensionPermissionMatrix',
  {
    permissions: 'Permissions',
    permissionsDescription:
      'Who may use this extension. These grants are stored separately from Seerr’s own permissions, so they survive the extension being disabled or reinstalled.',
    noPermissions: 'This extension declares no permissions.',
    noPermissionsDescription:
      'An extension has to declare permissions in its manifest for them to appear here.',
    notLoaded: 'This extension is not running',
    notLoadedDescription:
      'Its declared permissions are read from the running extension, so there is nothing to render until it loads. Existing grants are kept.',
    defaultForNewUsers: 'Grant to new users by default',
    defaultOverridden:
      'Overriding the extension’s own default of {manifestDefault}.',
    on: 'on',
    off: 'off',
    restoreDefaults: 'Restore the extension’s defaults',
    requiresCore: 'Also requires: {permissions}',
    viaAdmin: 'Administrator',
    inert: 'Inactive — lacks {permissions}',
    noCandidates:
      'No users hold this extension’s permissions yet. Grant one from a user’s own settings page, and they will appear here.',
    showingUsers: 'Showing {count} of {total} users.',
    loadMore: 'Show more',
    updateFailure: 'Could not update: {message}',
    updateSuccess: 'Permissions updated.',
    defaultsRestored: 'The extension’s own defaults apply again.',
  }
);

/** Mirrors `ExtensionPermissionHolder` in `seerr-api.yml`. */
interface Holder {
  id: number;
  displayName: string;
  email: string;
  avatar: string;
  granted: boolean;
  effective: boolean;
  effectiveByAdmin: boolean;
  missingCore: string[];
}

interface MatrixEntry {
  permission: string;
  key: string;
  name: string;
  description?: string;
  default: boolean;
  manifestDefault: boolean;
  operatorDefault?: boolean;
  requiresCore: string[];
  holders: Holder[];
}

interface Matrix {
  extensionId: string;
  permissions: MatrixEntry[];
  total: number;
  take: number;
  skip: number;
}

const PAGE_SIZE = 50;

const errorMessage = (e: unknown): string => {
  if (axios.isAxiosError(e)) {
    const message = (e.response?.data as { message?: string } | undefined)
      ?.message;

    if (message) {
      return message;
    }
  }

  return e instanceof Error ? e.message : String(e);
};

const ExtensionPermissionMatrix = ({
  extensionId,
  isLoaded,
}: {
  extensionId: string;
  isLoaded: boolean;
}) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [take, setTake] = useState(PAGE_SIZE);
  const url = `/api/v1/settings/extensions/${extensionId}/permissions`;
  const { data, error, mutate } = useSWR<Matrix>(`${url}?take=${take}&skip=0`);
  const [busy, setBusy] = useState<string>();

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  const entries = data?.permissions ?? [];

  if (!isLoaded && !entries.length) {
    return (
      <Alert title={intl.formatMessage(messages.notLoaded)} type="warning">
        {intl.formatMessage(messages.notLoadedDescription)}
      </Alert>
    );
  }

  if (!entries.length) {
    return (
      <Alert title={intl.formatMessage(messages.noPermissions)} type="info">
        {intl.formatMessage(messages.noPermissionsDescription)}
      </Alert>
    );
  }

  const act = async (
    key: string,
    request: () => Promise<unknown>,
    message: string
  ) => {
    setBusy(key);

    try {
      await request();

      addToast(message, { autoDismiss: true, appearance: 'success' });
    } catch (e) {
      addToast(
        intl.formatMessage(messages.updateFailure, {
          message: errorMessage(e),
        }),
        { appearance: 'error' }
      );
    } finally {
      setBusy(undefined);
      mutate();
    }
  };

  const toggleHolder = (entry: MatrixEntry, holder: Holder) =>
    act(
      `${entry.key}:${holder.id}`,
      () =>
        axios.post(`${url}/${entry.key}`, {
          userIds: [holder.id],
          granted: !holder.granted,
        }),
      intl.formatMessage(messages.updateSuccess)
    );

  const toggleDefault = (entry: MatrixEntry) =>
    act(
      `${entry.key}:default`,
      () =>
        axios.post(`${url}/${entry.key}/default`, { default: !entry.default }),
      intl.formatMessage(messages.updateSuccess)
    );

  const restoreDefaults = () =>
    act(
      'defaults',
      () => axios.delete(`${url}/defaults`),
      intl.formatMessage(messages.defaultsRestored)
    );

  const anyOverridden = entries.some(
    (entry) => entry.operatorDefault !== undefined
  );

  return (
    <>
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.permissions)}</h3>
        <p className="description">
          {intl.formatMessage(messages.permissionsDescription)}
        </p>
      </div>

      <ul className="space-y-6">
        {entries.map((entry) => (
          <li
            key={entry.permission}
            className="rounded-lg bg-gray-800 p-4 shadow ring-1 ring-gray-700"
          >
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div className="min-w-0">
                {/* Extension-authored, so rendered verbatim. */}
                <div className="text-lg font-semibold text-white">
                  {entry.name}
                </div>
                <div className="font-mono text-xs text-gray-500">
                  {entry.permission}
                </div>
                {entry.description && (
                  <p className="mt-1 text-sm text-gray-400">
                    {entry.description}
                  </p>
                )}
                {!!entry.requiresCore.length && (
                  <p className="mt-1 text-xs text-gray-500">
                    {intl.formatMessage(messages.requiresCore, {
                      permissions: entry.requiresCore.join(', '),
                    })}
                  </p>
                )}
              </div>

              {/* The default is per-permission policy for *new* users, so it sits
                  with the permission rather than with any user's row. */}
              <div className="flex-shrink-0 sm:text-right">
                <label className="mb-0 flex items-center gap-2 text-sm font-normal text-gray-300 sm:justify-end">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    disabled={busy === `${entry.key}:default`}
                    checked={entry.default}
                    onChange={() => toggleDefault(entry)}
                  />
                  <span>{intl.formatMessage(messages.defaultForNewUsers)}</span>
                </label>
                {entry.operatorDefault !== undefined && (
                  <p className="mt-1 text-xs text-yellow-500">
                    {intl.formatMessage(messages.defaultOverridden, {
                      manifestDefault: intl.formatMessage(
                        entry.manifestDefault ? messages.on : messages.off
                      ),
                    })}
                  </p>
                )}
              </div>
            </div>

            {!entry.holders.length ? (
              <p className="mt-4 text-sm text-gray-400">
                {intl.formatMessage(messages.noCandidates)}
              </p>
            ) : (
              <ul className="mt-4 divide-y divide-gray-700 border-t border-gray-700">
                {entry.holders.map((holder) => (
                  <li
                    key={`${entry.permission}-${holder.id}`}
                    className="flex items-center gap-3 py-2"
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 flex-shrink-0"
                      // An admin's permission comes from the short-circuit, so
                      // there is no row to remove and the box is inert rather
                      // than merely ticked.
                      disabled={
                        holder.effectiveByAdmin ||
                        busy === `${entry.key}:${holder.id}`
                      }
                      checked={holder.granted || holder.effectiveByAdmin}
                      onChange={() => toggleHolder(entry, holder)}
                    />
                    <CachedImage
                      type="avatar"
                      src={holder.avatar}
                      alt=""
                      width={24}
                      height={24}
                      className="h-6 w-6 flex-shrink-0 rounded-full object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-white">
                        {holder.displayName}
                      </div>
                      <div className="truncate text-xs text-gray-500">
                        {holder.email}
                      </div>
                    </div>
                    {holder.effectiveByAdmin && (
                      <Badge badgeType="primary">
                        {intl.formatMessage(messages.viaAdmin)}
                      </Badge>
                    )}
                    {/* Granted and stored, but not in effect: shown rather than
                        silently unticked, because the grant did save. */}
                    {holder.granted && !holder.effective && (
                      <Badge badgeType="warning">
                        {intl.formatMessage(messages.inert, {
                          permissions: holder.missingCore.join(', '),
                        })}
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-4 flex items-center justify-between">
        <span className="text-sm text-gray-400">
          {intl.formatMessage(messages.showingUsers, {
            count: Math.min(take, data?.total ?? 0),
            total: data?.total ?? 0,
          })}
        </span>
        <div className="flex gap-2">
          {anyOverridden && (
            <Button
              buttonType="default"
              type="button"
              disabled={busy === 'defaults'}
              onClick={restoreDefaults}
            >
              <span>{intl.formatMessage(messages.restoreDefaults)}</span>
            </Button>
          )}
          {(data?.total ?? 0) > take && (
            <Button
              buttonType="default"
              type="button"
              onClick={() => setTake(take + PAGE_SIZE)}
            >
              <span>{intl.formatMessage(messages.loadMore)}</span>
            </Button>
          )}
        </div>
      </div>
    </>
  );
};

export default ExtensionPermissionMatrix;
