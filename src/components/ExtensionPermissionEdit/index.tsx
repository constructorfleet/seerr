/**
 * The extension-permission half of the user editor.
 *
 * A parallel component rather than more entries in `PermissionEdit`, because the
 * two are different kinds of thing: core permissions are bits in an integer, so
 * `PermissionOption` toggles them arithmetically, while an extension permission is
 * a namespaced `<extensionId>:<key>` string in an `ext_permission` row. There is no
 * bit to add — and deliberately so, since the core `Permission` enum has only one
 * free bit and a per-extension bit would make a user's stored permissions depend on
 * what happens to be installed.
 *
 * Grouped by extension because the namespace is the only thing that makes two
 * identically-named permissions from different extensions distinguishable.
 */
import Alert from '@app/components/Common/Alert';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.ExtensionPermissionEdit', {
  extensionPermissions: 'Extension Permissions',
  extensionPermissionsDescription:
    'Permissions declared by installed extensions. These are stored separately from the permissions above, so they survive an extension being disabled or reinstalled.',
  noExtensionPermissions: 'No extensions declare any permissions.',
  adminGranted:
    'This user is an administrator, so every extension permission already applies to them.',
  requiresCore: 'Also requires: {permissions}',
  requiresUnmet:
    'Granted, but not in effect: this user does not hold {permissions}.',
});

/** Mirrors `ExtensionPermissionOption` in `seerr-api.yml`. */
export interface ExtensionPermissionOption {
  permission: string;
  extensionId: string;
  name: string;
  description?: string;
  requiresCore: string[];
}

interface ExtensionPermissionEditProps {
  available: ExtensionPermissionOption[];
  /** The permissions as stored, which is what this editor mutates. */
  granted: string[];
  /**
   * The subset that currently applies. Differs from `granted` when a
   * `requiresCore` is unmet, and is every declared permission for an admin — which
   * is worth surfacing, since otherwise an admin's unticked boxes look like a
   * permission they lack.
   */
  effective: string[];
  /** True when the target user is an admin, so the ADMIN short-circuit applies. */
  isAdmin?: boolean;
  disabled?: boolean;
  onUpdate: (granted: string[]) => void;
}

const ExtensionPermissionEdit = ({
  available,
  granted,
  effective,
  isAdmin,
  disabled,
  onUpdate,
}: ExtensionPermissionEditProps) => {
  const intl = useIntl();

  const byExtension = available.reduce<
    Record<string, ExtensionPermissionOption[]>
  >((groups, option) => {
    (groups[option.extensionId] ??= []).push(option);
    return groups;
  }, {});

  const grantedSet = new Set(granted);
  const effectiveSet = new Set(effective);

  const toggle = (permission: string) => {
    onUpdate(
      grantedSet.has(permission)
        ? granted.filter((existing) => existing !== permission)
        : [...granted, permission]
    );
  };

  return (
    <div className="mt-10">
      <div className="mb-6">
        <h3 className="heading">
          {intl.formatMessage(messages.extensionPermissions)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.extensionPermissionsDescription)}
        </p>
      </div>

      {!available.length ? (
        <Alert
          title={intl.formatMessage(messages.noExtensionPermissions)}
          type="info"
        />
      ) : (
        <>
          {isAdmin && (
            <div className="mb-4">
              <Alert
                title={intl.formatMessage(messages.adminGranted)}
                type="info"
              />
            </div>
          )}
          {Object.entries(byExtension).map(([extensionId, options]) => (
            <div key={`ext-perm-group-${extensionId}`} className="mb-6">
              <h4 className="mb-2 font-mono text-sm text-gray-400">
                {extensionId}
              </h4>
              {options.map((option) => {
                const isGranted = grantedSet.has(option.permission);
                // Granted but not effective means an unmet `requiresCore`. Shown
                // rather than silently unticked, because the box the operator
                // ticked did save — it just does not apply yet.
                const inertGrant =
                  isGranted && !effectiveSet.has(option.permission) && !isAdmin;

                return (
                  <div
                    key={`ext-perm-${option.permission}`}
                    className={`relative mt-4 flex items-start first:mt-0 ${
                      disabled || isAdmin ? 'opacity-50' : ''
                    }`}
                  >
                    <div className="flex h-6 items-center">
                      <input
                        id={`ext-perm-${option.permission}`}
                        name="extensionPermissions"
                        type="checkbox"
                        disabled={disabled || isAdmin}
                        checked={isAdmin || isGranted}
                        onChange={() => toggle(option.permission)}
                      />
                    </div>
                    <div className="ml-3 text-sm leading-6">
                      <label
                        htmlFor={`ext-perm-${option.permission}`}
                        className="block"
                        aria-label={option.name}
                      >
                        <div className="flex flex-col">
                          {/* Extension-authored, so rendered verbatim — an
                              extension's strings are not extractable for
                              translation. */}
                          <span className="font-medium text-white">
                            {option.name}
                          </span>
                          {option.description && (
                            <span className="font-normal text-gray-400">
                              {option.description}
                            </span>
                          )}
                          {!!option.requiresCore.length && (
                            <span className="mt-1 text-xs text-gray-500">
                              {intl.formatMessage(messages.requiresCore, {
                                permissions: option.requiresCore.join(', '),
                              })}
                            </span>
                          )}
                          {inertGrant && (
                            <span className="mt-1 text-xs text-yellow-500">
                              {intl.formatMessage(messages.requiresUnmet, {
                                permissions: option.requiresCore.join(', '),
                              })}
                            </span>
                          )}
                        </div>
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </>
      )}
    </div>
  );
};

export default ExtensionPermissionEdit;
