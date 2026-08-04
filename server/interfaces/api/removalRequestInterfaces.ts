import type MediaRemovalRequest from '@server/entity/MediaRemovalRequest';
import type { NonFunctionProperties, PaginatedResponse } from './common';

export interface RemovalRequestResultsResponse extends PaginatedResponse {
  results: NonFunctionProperties<MediaRemovalRequest>[];
}

export type MediaRemovalRequestBody = {
  mediaId: number;
  is4k?: boolean;
};

export interface RemovalRequestCountResponse {
  total: number;
  movie: number;
  tv: number;
  pending: number;
  approved: number;
  declined: number;
  failed: number;
  completed: number;
}
