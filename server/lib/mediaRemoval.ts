import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import type Media from '@server/entity/Media';
import { getSettings } from '@server/lib/settings';

/**
 * Thrown when there is no Radarr/Sonarr server configured that could serve
 * the removal, i.e. the media cannot be removed from any known service.
 */
export class NoServarrServerError extends Error {
  constructor(
    /** Display name of the service that was looked for, e.g. `4K Radarr`. */
    public readonly arrName: string
  ) {
    super(`No ${arrName} server configured to delete media files`);
  }
}

/**
 * Removes the media from the Radarr/Sonarr server it was added to and marks
 * the media (and, for series, every season) as deleted.
 *
 * The passed entity is mutated but *not* persisted — callers are responsible
 * for saving it, so that the removal and any related bookkeeping can share a
 * single write.
 *
 * @param media The media to remove
 * @param is4k Whether to remove the 4K variant
 */
export const removeMediaFromServarr = async (
  media: Media,
  is4k: boolean
): Promise<void> => {
  const settings = getSettings();
  const isMovie = media.mediaType === MediaType.MOVIE;

  let serviceSettings;
  if (isMovie) {
    serviceSettings = settings.radarr.find(
      (radarr) => radarr.isDefault && radarr.is4k === is4k
    );
  } else {
    serviceSettings = settings.sonarr.find(
      (sonarr) => sonarr.isDefault && sonarr.is4k === is4k
    );
  }

  const specificServiceId = is4k ? media.serviceId4k : media.serviceId;
  if (
    specificServiceId &&
    specificServiceId >= 0 &&
    serviceSettings?.id !== specificServiceId
  ) {
    if (isMovie) {
      serviceSettings = settings.radarr.find(
        (radarr) => radarr.id === specificServiceId
      );
    } else {
      serviceSettings = settings.sonarr.find(
        (sonarr) => sonarr.id === specificServiceId
      );
    }
  }

  if (!serviceSettings) {
    throw new NoServarrServerError(
      `${is4k ? '4K ' : ''}${isMovie ? 'Radarr' : 'Sonarr'}`
    );
  }

  if (isMovie) {
    const radarr = new RadarrAPI({
      apiKey: serviceSettings.apiKey,
      url: RadarrAPI.buildUrl(serviceSettings, '/api/v3'),
    });

    await radarr.removeMovie(media.tmdbId);
  } else {
    const tmdb = new TheMovieDb();
    const series = await tmdb.getTvShow({ tvId: media.tmdbId });
    const tvdbId = series.external_ids.tvdb_id ?? media.tvdbId;
    if (!tvdbId) {
      throw new Error('TVDB ID not found');
    }

    const sonarr = new SonarrAPI({
      apiKey: serviceSettings.apiKey,
      url: SonarrAPI.buildUrl(serviceSettings, '/api/v3'),
    });

    await sonarr.removeSeries(tvdbId);

    for (const season of media.seasons) {
      season[is4k ? 'status4k' : 'status'] = MediaStatus.DELETED;
    }
  }

  media[is4k ? 'status4k' : 'status'] = MediaStatus.DELETED;
  media.resetServiceData(is4k);
};
