import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRemovalRequest from '@server/entity/MediaRemovalRequest';
import { MediaRequest } from '@server/entity/MediaRequest';
import type {
  MediaRemovalRequestBody,
  RemovalRequestResultsResponse,
} from '@server/interfaces/api/removalRequestInterfaces';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';

const removalRequestRoutes = Router();

/**
 * Statuses that still stand in the way of a new removal request for the same
 * media. A declined or failed request may be re-submitted.
 */
const BLOCKING_STATUSES = [
  MediaRequestStatus.PENDING,
  MediaRequestStatus.APPROVED,
  MediaRequestStatus.COMPLETED,
];

/**
 * Media that is not yet available, so approving a removal for it destroys
 * nothing the user would miss.
 */
const isUnavailable = (media: Media, is4k: boolean): boolean =>
  ![MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE].includes(
    media[is4k ? 'status4k' : 'status']
  );

removalRequestRoutes.get<
  Record<string, unknown>,
  RemovalRequestResultsResponse
>('/', async (req, res, next) => {
  try {
    const pageSize = req.query.take ? Number(req.query.take) : 10;
    const skip = req.query.skip ? Number(req.query.skip) : 0;
    const requestedBy = req.query.requestedBy
      ? Number(req.query.requestedBy)
      : null;

    let statusFilter: MediaRequestStatus[];

    switch (req.query.filter) {
      case 'pending':
        statusFilter = [MediaRequestStatus.PENDING];
        break;
      case 'approved':
        statusFilter = [MediaRequestStatus.APPROVED];
        break;
      case 'declined':
        statusFilter = [MediaRequestStatus.DECLINED];
        break;
      case 'failed':
        statusFilter = [MediaRequestStatus.FAILED];
        break;
      case 'completed':
        statusFilter = [MediaRequestStatus.COMPLETED];
        break;
      default:
        statusFilter = [
          MediaRequestStatus.PENDING,
          MediaRequestStatus.APPROVED,
          MediaRequestStatus.DECLINED,
          MediaRequestStatus.FAILED,
          MediaRequestStatus.COMPLETED,
        ];
    }

    let query = getRepository(MediaRemovalRequest)
      .createQueryBuilder('removalRequest')
      .leftJoinAndSelect('removalRequest.media', 'media')
      .leftJoinAndSelect('removalRequest.modifiedBy', 'modifiedBy')
      .leftJoinAndSelect('removalRequest.requestedBy', 'requestedBy')
      .where('removalRequest.status IN (:...requestStatus)', {
        requestStatus: statusFilter,
      });

    if (
      !req.user?.hasPermission(
        [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
        { type: 'or' }
      )
    ) {
      if (requestedBy && requestedBy !== req.user?.id) {
        return next({
          status: 403,
          message:
            "You do not have permission to view this user's removal requests.",
        });
      }

      query = query.andWhere('requestedBy.id = :id', { id: req.user?.id });
    } else if (requestedBy) {
      query = query.andWhere('requestedBy.id = :id', { id: requestedBy });
    }

    switch (req.query.mediaType) {
      case 'movie':
        query = query.andWhere('removalRequest.type = :type', {
          type: MediaType.MOVIE,
        });
        break;
      case 'tv':
        query = query.andWhere('removalRequest.type = :type', {
          type: MediaType.TV,
        });
        break;
    }

    const [requests, requestCount] = await query
      .orderBy(
        req.query.sort === 'modified'
          ? 'removalRequest.updatedAt'
          : 'removalRequest.id',
        req.query.sortDirection === 'asc' ? 'ASC' : 'DESC'
      )
      .take(pageSize)
      .skip(skip)
      .getManyAndCount();

    return res.status(200).json({
      pageInfo: {
        pages: Math.ceil(requestCount / pageSize),
        pageSize,
        results: requestCount,
        page: Math.ceil(skip / pageSize) + 1,
      },
      results: requests,
    });
  } catch (e) {
    logger.error('Something went wrong retrieving removal requests', {
      label: 'Media Removal Request',
      errorMessage: e.message,
    });
    next({ status: 500, message: 'Unable to retrieve removal requests.' });
  }
});

removalRequestRoutes.post<never, MediaRemovalRequest, MediaRemovalRequestBody>(
  '/',
  isAuthenticated(Permission.REQUEST_REMOVE),
  async (req, res, next) => {
    if (!req.user) {
      return next({
        status: 401,
        message: 'You must be logged in to request media removal.',
      });
    }

    try {
      const media = await getRepository(Media).findOne({
        where: { id: Number(req.body.mediaId) },
      });

      if (!media) {
        return next({ status: 404, message: 'Media not found.' });
      }

      const is4k = req.body.is4k ?? false;
      const canManage = req.user.hasPermission(Permission.MANAGE_REQUESTS);

      if (media[is4k ? 'status4k' : 'status'] === MediaStatus.DELETED) {
        return next({
          status: 400,
          message: 'This media has already been removed.',
        });
      }

      // Anyone who can approve removals may remove anything; everyone else may
      // only unrequest what they themselves asked for.
      if (!canManage) {
        const ownsRequest = await getRepository(MediaRequest).exists({
          where: {
            media: { id: media.id },
            requestedBy: { id: req.user.id },
            is4k,
          },
        });

        if (!ownsRequest) {
          return next({
            status: 403,
            message:
              'You can only request removal of media you requested yourself.',
          });
        }
      }

      const removalRequestRepository = getRepository(MediaRemovalRequest);

      const duplicate = await removalRequestRepository.exists({
        where: BLOCKING_STATUSES.map((status) => ({
          media: { id: media.id },
          is4k,
          status,
        })),
      });

      if (duplicate) {
        return next({
          status: 409,
          message: 'A removal request for this media already exists.',
        });
      }

      // Evaluated before the insert so that the entity's @AfterInsert
      // autoapproval hook fires and the notification reads as automatic.
      const autoApprove =
        canManage ||
        (getSettings().main.autoApproveRemovalWhenUnavailable &&
          isUnavailable(media, is4k));

      const removalRequest = await removalRequestRepository.save(
        new MediaRemovalRequest({
          status: autoApprove
            ? MediaRequestStatus.APPROVED
            : MediaRequestStatus.PENDING,
          media,
          requestedBy: req.user,
          modifiedBy: autoApprove && canManage ? req.user : null,
          type: media.mediaType,
          is4k,
        })
      );

      logger.info('Removal request created', {
        label: 'Media Removal Request',
        removalRequestId: removalRequest.id,
        mediaId: media.id,
        is4k,
        autoApprove,
      });

      return res.status(201).json(removalRequest);
    } catch (e) {
      logger.error('Something went wrong creating a removal request', {
        label: 'Media Removal Request',
        errorMessage: e.message,
      });
      next({ status: 500, message: 'Unable to create removal request.' });
    }
  }
);

removalRequestRoutes.get('/:removalRequestId', async (req, res, next) => {
  try {
    const removalRequest = await getRepository(
      MediaRemovalRequest
    ).findOneOrFail({
      where: { id: Number(req.params.removalRequestId) },
      relations: { requestedBy: true, modifiedBy: true },
    });

    if (
      removalRequest.requestedBy.id !== req.user?.id &&
      !req.user?.hasPermission(
        [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
        { type: 'or' }
      )
    ) {
      return next({
        status: 403,
        message: 'You do not have permission to view this removal request.',
      });
    }

    return res.status(200).json(removalRequest);
  } catch (e) {
    logger.debug('Failed to retrieve removal request.', {
      label: 'Media Removal Request',
      errorMessage: e.message,
    });
    next({ status: 404, message: 'Removal request not found.' });
  }
});

removalRequestRoutes.delete('/:removalRequestId', async (req, res, next) => {
  const removalRequestRepository = getRepository(MediaRemovalRequest);

  try {
    const removalRequest = await removalRequestRepository.findOneOrFail({
      where: { id: Number(req.params.removalRequestId) },
      relations: { requestedBy: true, modifiedBy: true },
    });

    if (
      !req.user?.hasPermission(Permission.MANAGE_REQUESTS) &&
      (removalRequest.requestedBy.id !== req.user?.id ||
        removalRequest.status !== MediaRequestStatus.PENDING)
    ) {
      return next({
        status: 403,
        message: 'You do not have permission to delete this removal request.',
      });
    }

    await removalRequestRepository.remove(removalRequest);

    return res.status(204).send();
  } catch (e) {
    logger.debug('Failed to delete removal request.', {
      label: 'Media Removal Request',
      errorMessage: e.message,
    });
    next({ status: 404, message: 'Removal request not found.' });
  }
});

removalRequestRoutes.post<{
  removalRequestId: string;
  status: string;
}>(
  '/:removalRequestId/:status',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    const removalRequestRepository = getRepository(MediaRemovalRequest);

    // Resolved before the lookup so an unknown status cannot write `undefined`.
    const newStatus = {
      pending: MediaRequestStatus.PENDING,
      approve: MediaRequestStatus.APPROVED,
      decline: MediaRequestStatus.DECLINED,
    }[req.params.status];

    if (!newStatus) {
      return next({
        status: 400,
        message: `Unknown removal request status: ${req.params.status}`,
      });
    }

    try {
      const removalRequest = await removalRequestRepository.findOneOrFail({
        where: { id: Number(req.params.removalRequestId) },
        relations: { requestedBy: true, modifiedBy: true },
      });

      // Approving here is what triggers the removal, via the subscriber.
      removalRequest.status = newStatus;
      removalRequest.modifiedBy = req.user;
      await removalRequestRepository.save(removalRequest);

      return res.status(200).json(removalRequest);
    } catch (e) {
      logger.error('Error processing removal request update', {
        label: 'Media Removal Request',
        errorMessage: e.message,
      });
      next({ status: 404, message: 'Removal request not found.' });
    }
  }
);

export default removalRequestRoutes;
