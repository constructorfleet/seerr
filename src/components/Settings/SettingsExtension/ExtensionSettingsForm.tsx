/**
 * The admin form for one extension's declared settings.
 *
 * The host renders this from the manifest's schema rather than letting the
 * extension ship its own form. An extension-drawn admin page would look like
 * core's without being it — same shell, unreviewed markup, and no guarantee that
 * what it displays is what the host will actually persist. Declaring a schema
 * costs the extension author the freedom to draw anything, and buys the operator
 * a form whose validation is the same on both sides of the request.
 *
 * Secrets are the one field type that is not round-trippable: the server sends a
 * sentinel, never the value. Submitting the sentinel back means "leave
 * unchanged", so clearing one is a separate button rather than an empty save.
 */
import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.Settings.SettingsExtension.ExtensionSettingsForm',
  {
    settings: 'Settings',
    settingsDescription:
      'Configuration this extension declares. Seerr validates and stores these values; the extension reads them at runtime.',
    noSettings: 'This extension declares no settings.',
    noSettingsDescription:
      'An extension has to declare a settings schema in its manifest for one to appear here.',
    notLoaded: 'This extension is not running',
    notLoadedDescription:
      'Its settings schema is read from the running extension, so there is nothing to render until it loads. Any values you saved earlier are still stored.',
    secretSet: 'Saved. Leave this alone to keep it, or type a new value.',
    secretUnset: 'Not set.',
    clear: 'Clear',
    reset: 'Reset to defaults',
    resetConfirm: 'Forget every saved value for this extension?',
    required: 'Required',
    saveFailure: 'Could not save: {message}',
    saveSuccess: 'Settings saved.',
    clearSuccess: '{name} cleared.',
    resetSuccess: 'Settings reset to their defaults.',
  }
);

/** Mirrors `ExtensionSettingDeclaration` in `seerr-api.yml`. */
export interface ExtensionSettingDeclaration {
  key: string;
  type: 'boolean' | 'string' | 'number' | 'select' | 'secret';
  name: string;
  description?: string;
  default?: boolean | string | number;
  options?: { value: string; label: string }[];
  required?: boolean;
  min?: number;
  max?: number;
}

interface ExtensionSettingsFormResponse {
  extensionId: string;
  settings: ExtensionSettingDeclaration[];
  values: Record<string, boolean | string | number>;
}

/** What the server reports for a `secret` that is set. */
const REDACTED_SECRET = '********';

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

/**
 * The value a control starts at.
 *
 * A key the operator has never saved and which declares no default has no value
 * at all, and each control needs *something* — so the empty state is per-type
 * rather than a shared `''`, which would make a number input render `NaN` and a
 * checkbox render as indeterminate.
 */
function initialValue(
  declared: ExtensionSettingDeclaration,
  values: Record<string, boolean | string | number>
): boolean | string | number {
  if (declared.key in values) {
    return values[declared.key];
  }

  if (declared.default !== undefined) {
    return declared.default;
  }

  switch (declared.type) {
    case 'boolean':
      return false;
    case 'number':
      return declared.min ?? 0;
    case 'select':
      return declared.options?.[0]?.value ?? '';
    default:
      return '';
  }
}

const ExtensionSettingsForm = ({
  extensionId,
  isLoaded,
}: {
  extensionId: string;
  /** False for a disabled or not-yet-restarted extension, which declares nothing. */
  isLoaded: boolean;
}) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const url = `/api/v1/settings/extensions/${extensionId}/settings`;
  const { data, error, mutate } = useSWR<ExtensionSettingsFormResponse>(url);
  const [draft, setDraft] = useState<Record<
    string,
    boolean | string | number
  > | null>(null);
  const [saving, setSaving] = useState(false);

  // Seeded from the server's values, and re-seeded whenever they change — after a
  // save, a clear, or a reset. Held locally rather than driven straight off SWR
  // so an in-progress edit is not thrown away by a background revalidation.
  useEffect(() => {
    if (!data) {
      return;
    }

    setDraft(
      Object.fromEntries(
        data.settings.map((declared) => [
          declared.key,
          initialValue(declared, data.values),
        ])
      )
    );
  }, [data]);

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  const declarations = data?.settings ?? [];

  if (!isLoaded && !declarations.length) {
    return (
      <Alert title={intl.formatMessage(messages.notLoaded)} type="warning">
        {intl.formatMessage(messages.notLoadedDescription)}
      </Alert>
    );
  }

  if (!declarations.length) {
    return (
      <Alert title={intl.formatMessage(messages.noSettings)} type="info">
        {intl.formatMessage(messages.noSettingsDescription)}
      </Alert>
    );
  }

  const set = (key: string, value: boolean | string | number) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const save = async () => {
    if (!draft) {
      return;
    }

    setSaving(true);

    try {
      // A `secret` still showing the sentinel is submitted as-is: the server reads
      // that as "leave unchanged", which is the only correct reading given the
      // client was never told the real value.
      await axios.post(url, { values: draft });

      addToast(intl.formatMessage(messages.saveSuccess), {
        autoDismiss: true,
        appearance: 'success',
      });
    } catch (e) {
      addToast(
        intl.formatMessage(messages.saveFailure, { message: errorMessage(e) }),
        { appearance: 'error' }
      );
    } finally {
      setSaving(false);
      mutate();
    }
  };

  const clear = async (declared: ExtensionSettingDeclaration) => {
    try {
      await axios.delete(`${url}/${declared.key}`);

      addToast(
        intl.formatMessage(messages.clearSuccess, { name: declared.name }),
        { autoDismiss: true, appearance: 'success' }
      );
    } catch (e) {
      addToast(
        intl.formatMessage(messages.saveFailure, { message: errorMessage(e) }),
        { appearance: 'error' }
      );
    } finally {
      mutate();
    }
  };

  const reset = async () => {
    if (!window.confirm(intl.formatMessage(messages.resetConfirm))) {
      return;
    }

    try {
      await axios.delete(url);

      addToast(intl.formatMessage(messages.resetSuccess), {
        autoDismiss: true,
        appearance: 'success',
      });
    } catch (e) {
      addToast(
        intl.formatMessage(messages.saveFailure, { message: errorMessage(e) }),
        { appearance: 'error' }
      );
    } finally {
      mutate();
    }
  };

  return (
    <>
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.settings)}</h3>
        <p className="description">
          {intl.formatMessage(messages.settingsDescription)}
        </p>
      </div>

      <div className="section">
        {declarations.map((declared) => {
          const value = draft?.[declared.key];
          const id = `ext-setting-${declared.key}`;
          // Whether the *stored* secret is set, which the draft cannot tell us:
          // an operator who has typed a replacement has already overwritten the
          // sentinel locally.
          const secretIsSet = data?.values[declared.key] === REDACTED_SECRET;

          return (
            <div className="form-row" key={id}>
              {declared.type === 'boolean' ? (
                <label htmlFor={id} className="checkbox-label">
                  {/* Extension-authored, so rendered verbatim: an extension's
                      strings are not extractable for translation. */}
                  <span>{declared.name}</span>
                  {declared.description && (
                    <span className="label-tip">{declared.description}</span>
                  )}
                </label>
              ) : (
                <label htmlFor={id} className="text-label">
                  <span>{declared.name}</span>
                  {declared.required && (
                    <span className="label-required">*</span>
                  )}
                  {declared.description && (
                    <span className="label-tip">{declared.description}</span>
                  )}
                </label>
              )}
              <div className="form-input-area">
                {declared.type === 'boolean' && (
                  <input
                    type="checkbox"
                    id={id}
                    checked={value === true}
                    onChange={() => set(declared.key, value !== true)}
                  />
                )}

                {declared.type === 'select' && (
                  <select
                    id={id}
                    value={String(value ?? '')}
                    onChange={(e) => set(declared.key, e.target.value)}
                  >
                    {declared.options?.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                )}

                {declared.type === 'number' && (
                  <div className="form-input-field">
                    <input
                      type="text"
                      inputMode="numeric"
                      id={id}
                      className="short"
                      value={String(value ?? '')}
                      min={declared.min}
                      max={declared.max}
                      onChange={(e) => {
                        // Kept as a number so the server's type check is not
                        // failed by a string that happens to look numeric. An
                        // unparseable entry is left for the server to reject with
                        // the same message every other bad value gets.
                        const parsed = Number(e.target.value);

                        set(
                          declared.key,
                          e.target.value === '' || Number.isNaN(parsed)
                            ? e.target.value
                            : parsed
                        );
                      }}
                    />
                  </div>
                )}

                {declared.type === 'string' && (
                  <div className="form-input-field">
                    <input
                      type="text"
                      id={id}
                      value={String(value ?? '')}
                      onChange={(e) => set(declared.key, e.target.value)}
                    />
                  </div>
                )}

                {declared.type === 'secret' && (
                  <>
                    <div className="form-input-field">
                      <input
                        type="password"
                        id={id}
                        autoComplete="new-password"
                        value={String(value ?? '')}
                        onChange={(e) => set(declared.key, e.target.value)}
                      />
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-xs text-gray-400">
                      <span>
                        {intl.formatMessage(
                          secretIsSet
                            ? messages.secretSet
                            : messages.secretUnset
                        )}
                      </span>
                      {/* A save cannot clear a secret — the sentinel and the
                          empty string both mean "no change" — so this is the
                          only way to unset one. */}
                      {secretIsSet && (
                        <button
                          type="button"
                          className="text-indigo-400 hover:text-indigo-300"
                          onClick={() => clear(declared)}
                        >
                          {intl.formatMessage(messages.clear)}
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })}

        <div className="actions">
          <div className="flex justify-between">
            <Button buttonType="default" type="button" onClick={reset}>
              <ArrowPathIcon />
              <span>{intl.formatMessage(messages.reset)}</span>
            </Button>
            <Button
              buttonType="primary"
              type="button"
              disabled={saving}
              onClick={save}
            >
              <span>
                {intl.formatMessage(
                  saving ? globalMessages.saving : globalMessages.save
                )}
              </span>
            </Button>
          </div>
        </div>
      </div>
    </>
  );
};

export default ExtensionSettingsForm;
