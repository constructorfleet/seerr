import Modal from '@app/components/Common/Modal';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { TrashIcon } from '@heroicons/react/24/outline';
import { MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';

// The warning copy is deliberately blunt: approval is destructive, so it says
// plainly what disappears. Keep comments out of the object below — the i18n
// extractor parses it as JSON and silently skips files it cannot parse.
const messages = defineMessages('components.RemovalRequestModal', {
  title: 'Request Removal of {title}',
  title4k: 'Request Removal of {title} in 4K',
  requestremoval: 'Request Removal',
  requestingremoval: 'Requesting…',
  warningavailable:
    'Once approved, {title} and its downloaded files will be deleted from {arr}. This cannot be undone.',
  warningunavailable:
    'Once approved, {title} will be removed from {arr}. Nothing has finished downloading yet, so no files will be lost.',
  pendingapproval:
    'Your removal request requires approval. Nothing will be deleted until an administrator approves it.',
  autoapproved:
    'Your removal request will be approved automatically, and {title} will be deleted right away.',
  requestsuccess:
    'Your removal request for <strong>{title}</strong> was submitted.',
  requesterror: 'Something went wrong while submitting your removal request.',
  alreadyrequested: 'A removal request for {title} already exists.',
});

interface RemovalRequestModalProps {
  show: boolean;
  media: Media;
  title: string;
  mediaType: 'movie' | 'tv';
  is4k?: boolean;
  onComplete: () => void;
  onCancel: () => void;
}

const RemovalRequestModal = ({
  show,
  media,
  title,
  mediaType,
  is4k = false,
  onComplete,
  onCancel,
}: RemovalRequestModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { hasPermission } = useUser();
  const settings = useSettings();
  const [isSubmitting, setSubmitting] = useState(false);

  const arr = mediaType === 'movie' ? 'Radarr' : 'Sonarr';
  const status = media[is4k ? 'status4k' : 'status'];
  const isAvailable =
    status === MediaStatus.AVAILABLE ||
    status === MediaStatus.PARTIALLY_AVAILABLE;

  // Mirrors the server's auto-approval rules in server/routes/removalRequest.ts
  // so the copy matches what will actually happen.
  const willAutoApprove =
    hasPermission(Permission.MANAGE_REQUESTS) ||
    (settings.currentSettings.autoApproveRemovalWhenUnavailable &&
      !isAvailable);

  const sendRemovalRequest = async () => {
    setSubmitting(true);

    try {
      await axios.post('/api/v1/removal', { mediaId: media.id, is4k });

      addToast(
        intl.formatMessage(messages.requestsuccess, {
          title,
          strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
        }),
        { appearance: 'success', autoDismiss: true }
      );
      onComplete();
    } catch (e) {
      addToast(
        intl.formatMessage(
          axios.isAxiosError(e) && e.response?.status === 409
            ? messages.alreadyrequested
            : messages.requesterror,
          { title }
        ),
        { appearance: 'error', autoDismiss: true }
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Transition
      as="div"
      enter="transition ease-in-out duration-300 transform opacity-0"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition ease-in-out duration-300 transform opacity-100"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
      show={show}
    >
      <Modal
        title={intl.formatMessage(is4k ? messages.title4k : messages.title, {
          title,
        })}
        onCancel={onCancel}
        cancelText={intl.formatMessage(globalMessages.cancel)}
        onOk={() => sendRemovalRequest()}
        okDisabled={isSubmitting}
        okText={intl.formatMessage(
          isSubmitting ? messages.requestingremoval : messages.requestremoval
        )}
        okButtonType="danger"
        backgroundClickable
      >
        <div className="flex items-start space-x-3">
          <TrashIcon className="h-6 w-6 flex-shrink-0 text-red-500" />
          <div className="space-y-2 text-sm text-gray-300">
            <p>
              {intl.formatMessage(
                isAvailable
                  ? messages.warningavailable
                  : messages.warningunavailable,
                { title, arr }
              )}
            </p>
            <p className="text-gray-400">
              {willAutoApprove
                ? intl.formatMessage(messages.autoapproved, { title })
                : intl.formatMessage(messages.pendingapproval)}
            </p>
          </div>
        </div>
      </Modal>
    </Transition>
  );
};

export default RemovalRequestModal;
