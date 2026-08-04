import Spinner from '@app/assets/spinner.svg';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { CheckIcon, XMarkIcon } from '@heroicons/react/24/solid';
import { MediaRequestStatus } from '@server/constants/media';
import type { RemovalRequestResultsResponse } from '@server/interfaces/api/removalRequestInterfaces';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import axios from 'axios';
import Link from 'next/link';
import { useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

const messages = defineMessages(
  'components.RemovalRequestList.RemovalRequestItem',
  {
    failedmodify: 'Something went wrong while modifying the removal request.',
    faileddelete: 'Something went wrong while deleting the removal request.',
    requested: 'Requested',
    requesteddate: 'Requested',
    modified: 'Modified',
    modifieduserdate: '{date} by {user}',
    unknowntitle: 'Unknown Title',
    cancelremoval: 'Cancel Removal Request',
    approveremoval: 'Approve Removal',
    declineremoval: 'Decline Removal',
    deleteremoval: 'Delete Removal Request',
    fourk: '4K',
  }
);

const isMovie = (media: MovieDetails | TvDetails): media is MovieDetails =>
  (media as MovieDetails).title !== undefined;

interface RemovalRequestItemProps {
  request: RemovalRequestResultsResponse['results'][number];
  revalidateList: () => void;
}

const RemovalRequestItem = ({
  request,
  revalidateList,
}: RemovalRequestItemProps) => {
  const { ref, inView } = useInView({ triggerOnce: true });
  const { addToast } = useToasts();
  const intl = useIntl();
  const { user, hasPermission } = useUser();
  const [updatingType, setUpdatingType] = useState<
    'approve' | 'decline' | null
  >(null);

  const url =
    request.type === 'movie'
      ? `/api/v1/movie/${request.media.tmdbId}`
      : `/api/v1/tv/${request.media.tmdbId}`;
  const { data: title, error } = useSWR<MovieDetails | TvDetails>(
    inView ? url : null
  );

  const modifyRequest = async (type: 'approve' | 'decline') => {
    setUpdatingType(type);
    try {
      await axios.post(`/api/v1/removal/${request.id}/${type}`);
      revalidateList();
      mutate('/api/v1/removal/count');
    } catch {
      addToast(intl.formatMessage(messages.failedmodify), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setUpdatingType(null);
    }
  };

  const deleteRequest = async () => {
    try {
      await axios.delete(`/api/v1/removal/${request.id}`);
      revalidateList();
      mutate('/api/v1/removal/count');
    } catch {
      addToast(intl.formatMessage(messages.faileddelete), {
        autoDismiss: true,
        appearance: 'error',
      });
    }
  };

  if (!title && !error) {
    return (
      <div
        className="h-64 w-full animate-pulse rounded-xl bg-gray-800 xl:h-28"
        ref={ref}
      />
    );
  }

  const mediaLink =
    request.type === 'movie'
      ? `/movie/${request.media.tmdbId}`
      : `/tv/${request.media.tmdbId}`;
  const displayTitle = title
    ? isMovie(title)
      ? title.title
      : title.name
    : intl.formatMessage(messages.unknowntitle);
  const year = title
    ? (isMovie(title) ? title.releaseDate : title.firstAirDate)?.slice(0, 4)
    : undefined;

  // The owner may still withdraw while pending; approvers may clear anything.
  const canDelete = hasPermission(Permission.MANAGE_REQUESTS);
  const canCancel =
    !canDelete &&
    request.requestedBy.id === user?.id &&
    request.status === MediaRequestStatus.PENDING;

  return (
    <div className="relative flex w-full flex-col justify-between overflow-hidden rounded-xl bg-gray-800 py-2 text-gray-400 shadow-md ring-1 ring-gray-700 xl:h-28 xl:flex-row">
      {title?.backdropPath && (
        <div className="absolute inset-0 z-0 w-full bg-cover bg-center xl:w-2/3">
          <CachedImage
            type="tmdb"
            src={`https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${title.backdropPath}`}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            fill
          />
          <div
            className="absolute inset-0"
            style={{
              backgroundImage:
                'linear-gradient(90deg, rgba(31, 41, 55, 0.47) 0%, rgba(31, 41, 55, 1) 100%)',
            }}
          />
        </div>
      )}
      <div className="relative flex w-full flex-col justify-between overflow-hidden sm:flex-row">
        <div className="relative z-10 flex w-full items-center overflow-hidden pl-4 pr-4 sm:pr-0 xl:w-7/12 2xl:w-2/3">
          <Link
            href={mediaLink}
            className="relative h-auto w-12 flex-shrink-0 scale-100 transform-gpu overflow-hidden rounded-md transition duration-300 hover:scale-105"
          >
            <CachedImage
              type="tmdb"
              src={
                title?.posterPath
                  ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${title.posterPath}`
                  : '/images/seerr_poster_not_found.png'
              }
              alt=""
              sizes="100vw"
              style={{ width: '100%', height: 'auto', objectFit: 'cover' }}
              width={600}
              height={900}
            />
          </Link>
          <div className="flex flex-col justify-center overflow-hidden pl-2 xl:pl-4">
            <div className="pt-0.5 text-xs font-medium text-white sm:pt-1">
              {year}
            </div>
            <Link
              href={mediaLink}
              className="mr-2 min-w-0 truncate text-lg font-bold text-white hover:underline xl:text-xl"
            >
              {displayTitle}
            </Link>
          </div>
        </div>
        <div className="z-10 ml-4 mt-4 flex w-full flex-col justify-center gap-1 overflow-hidden pr-4 text-sm sm:ml-2 sm:mt-0 xl:flex-1 xl:pr-0">
          <div className="card-field">
            <span className="card-field-name">
              {intl.formatMessage(globalMessages.status)}
            </span>
            <span className="flex items-center space-x-2">
              {request.status === MediaRequestStatus.PENDING ? (
                <Badge badgeType="warning">
                  {intl.formatMessage(globalMessages.pending)}
                </Badge>
              ) : request.status === MediaRequestStatus.DECLINED ? (
                <Badge badgeType="danger">
                  {intl.formatMessage(globalMessages.declined)}
                </Badge>
              ) : request.status === MediaRequestStatus.FAILED ? (
                <Badge badgeType="danger">
                  {intl.formatMessage(globalMessages.failed)}
                </Badge>
              ) : (
                <Badge badgeType="success">
                  {intl.formatMessage(globalMessages.approved)}
                </Badge>
              )}
              {request.is4k && (
                <Badge badgeType="default">
                  {intl.formatMessage(messages.fourk)}
                </Badge>
              )}
            </span>
          </div>
          <div className="card-field">
            {hasPermission(
              [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
              { type: 'or' }
            ) ? (
              <>
                <span className="card-field-name">
                  {intl.formatMessage(messages.requested)}
                </span>
                <span className="flex truncate text-sm text-gray-300">
                  {intl.formatMessage(messages.modifieduserdate, {
                    date: (
                      <FormattedRelativeTime
                        value={Math.floor(
                          (new Date(request.createdAt).getTime() - Date.now()) /
                            1000
                        )}
                        updateIntervalInSeconds={1}
                        numeric="auto"
                      />
                    ),
                    user: (
                      <Link
                        href={`/users/${request.requestedBy.id}`}
                        className="group flex items-center truncate"
                      >
                        <span className="avatar-sm ml-1.5">
                          <CachedImage
                            type="avatar"
                            src={request.requestedBy.avatar}
                            alt=""
                            className="avatar-sm object-cover"
                            width={20}
                            height={20}
                          />
                        </span>
                        <span className="truncate text-sm font-semibold group-hover:text-white group-hover:underline">
                          {request.requestedBy.displayName}
                        </span>
                      </Link>
                    ),
                  })}
                </span>
              </>
            ) : (
              <>
                <span className="card-field-name">
                  {intl.formatMessage(messages.requesteddate)}
                </span>
                <span className="flex truncate text-sm text-gray-300">
                  <FormattedRelativeTime
                    value={Math.floor(
                      (new Date(request.createdAt).getTime() - Date.now()) /
                        1000
                    )}
                    updateIntervalInSeconds={1}
                    numeric="auto"
                  />
                </span>
              </>
            )}
          </div>
          {request.modifiedBy && (
            <div className="card-field">
              <span className="card-field-name">
                {intl.formatMessage(messages.modified)}
              </span>
              <span className="flex truncate text-sm text-gray-300">
                {intl.formatMessage(messages.modifieduserdate, {
                  date: (
                    <FormattedRelativeTime
                      value={Math.floor(
                        (new Date(request.updatedAt).getTime() - Date.now()) /
                          1000
                      )}
                      updateIntervalInSeconds={1}
                      numeric="auto"
                    />
                  ),
                  user: (
                    <Link
                      href={`/users/${request.modifiedBy.id}`}
                      className="group flex items-center truncate"
                    >
                      <span className="avatar-sm ml-1.5">
                        <CachedImage
                          type="avatar"
                          src={request.modifiedBy.avatar}
                          alt=""
                          className="avatar-sm object-cover"
                          width={20}
                          height={20}
                        />
                      </span>
                      <span className="truncate text-sm font-semibold group-hover:text-white group-hover:underline">
                        {request.modifiedBy.displayName}
                      </span>
                    </Link>
                  ),
                })}
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="z-10 mt-4 flex w-full flex-col justify-center space-y-2 pl-4 pr-4 xl:mt-0 xl:w-96 xl:items-end xl:pl-0">
        {hasPermission(Permission.MANAGE_REQUESTS) &&
          request.status === MediaRequestStatus.PENDING && (
            <div className="flex w-full flex-row space-x-2">
              <span className="w-full">
                {/* Approving deletes files, so it is behind a confirm step. */}
                <ConfirmButton
                  onClick={() => modifyRequest('approve')}
                  confirmText={intl.formatMessage(globalMessages.areyousure)}
                  className="w-full"
                >
                  {updatingType === 'approve' ? <Spinner /> : <CheckIcon />}
                  <span>{intl.formatMessage(messages.approveremoval)}</span>
                </ConfirmButton>
              </span>
              <span className="w-full">
                <Button
                  className="w-full"
                  buttonType="primary"
                  disabled={updatingType !== null}
                  onClick={() => modifyRequest('decline')}
                >
                  {updatingType === 'decline' ? <Spinner /> : <XMarkIcon />}
                  <span>{intl.formatMessage(messages.declineremoval)}</span>
                </Button>
              </span>
            </div>
          )}
        {canDelete && (
          <ConfirmButton
            onClick={() => deleteRequest()}
            confirmText={intl.formatMessage(globalMessages.areyousure)}
            className="w-full"
          >
            <XMarkIcon />
            <span>{intl.formatMessage(messages.deleteremoval)}</span>
          </ConfirmButton>
        )}
        {canCancel && (
          <ConfirmButton
            onClick={() => deleteRequest()}
            confirmText={intl.formatMessage(globalMessages.areyousure)}
            className="w-full"
          >
            <XMarkIcon />
            <span>{intl.formatMessage(messages.cancelremoval)}</span>
          </ConfirmButton>
        )}
      </div>
    </div>
  );
};

export default RemovalRequestItem;
