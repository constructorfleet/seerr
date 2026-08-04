import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRemovalRequest from '@server/entity/MediaRemovalRequest';
import { User } from '@server/entity/User';
import { seedTestDb } from '@server/utils/seedTestDb';

// Builds the schema from the migration files rather than from the entity
// metadata, so a table shape that drifts from the entity is caught here rather
// than in production.
describe('media_removal_request migration', () => {
  before(async () => {
    await seedTestDb({ withMigrations: true });
  });

  after(async () => {
    // Leave the shared in-memory database in the synchronized state the rest
    // of the suite expects.
    await seedTestDb();
  });

  it('creates a media_removal_request table', async () => {
    const table = await dataSource
      .createQueryRunner()
      .getTable('media_removal_request');

    assert.ok(table, 'expected the migrations to create the table');
  });

  it('creates every column the entity maps, with the expected nullability', async () => {
    const table = await dataSource
      .createQueryRunner()
      .getTable('media_removal_request');

    const nullableByColumn = Object.fromEntries(
      (table?.columns ?? []).map((column) => [column.name, column.isNullable])
    );

    assert.deepStrictEqual(nullableByColumn, {
      id: false,
      status: false,
      is4k: false,
      type: false,
      createdAt: false,
      updatedAt: false,
      mediaId: true,
      requestedById: true,
      modifiedById: true,
    });
  });

  it('indexes the columns the removal request queries filter on', async () => {
    const table = await dataSource
      .createQueryRunner()
      .getTable('media_removal_request');

    const indexed = (table?.indices ?? [])
      .flatMap((index) => index.columnNames)
      .sort();

    assert.deepStrictEqual(indexed, [
      'mediaId',
      'modifiedById',
      'requestedById',
      'status',
    ]);
  });

  it('accepts a row written through the entity', async () => {
    const removalRequestRepository = getRepository(MediaRemovalRequest);
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 550,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const saved = await removalRequestRepository.save(
      new MediaRemovalRequest({
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: await getRepository(User).findOneOrFail({
          where: { email: 'admin@seerr.dev' },
        }),
        type: MediaType.MOVIE,
      })
    );

    const found = await removalRequestRepository.findOneOrFail({
      where: { id: saved.id },
    });

    assert.strictEqual(found.status, MediaRequestStatus.PENDING);
    assert.strictEqual(found.is4k, false);
  });
});
