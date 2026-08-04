import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import {
  extensionMigrationsTableName,
  extensionTablePrefix,
  runExtensionMigrations,
} from '@server/lib/extensions/migrations';
import type {
  DataSourceOptions,
  MigrationInterface,
  QueryRunner,
} from 'typeorm';
import { DataSource } from 'typeorm';

/**
 * The suite's shared DataSource is `:memory:`, and a second sqlite DataSource
 * opened on `:memory:` is a *different* database — so these tests run against a
 * throwaway file, standing in for the main database the runner points at.
 */
let directory: string;
let baseOptions: DataSourceOptions;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'seerr-ext-migrations-'));
  baseOptions = {
    type: 'sqlite',
    database: path.join(directory, 'db.sqlite3'),
    entities: [],
    migrations: [],
  };

  // Stand in for the core schema: a `migrations` table the runner must leave
  // alone, and a table an ill-behaved extension might try to touch.
  const core = await new DataSource(baseOptions).initialize();
  await core.query(
    `CREATE TABLE "migrations" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "timestamp" bigint NOT NULL, "name" varchar NOT NULL)`
  );
  await core.query(
    `CREATE TABLE "user" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "email" varchar NOT NULL)`
  );
  await core.destroy();
});

afterEach(async () => {
  mock.restoreAll();
  await fs.rm(directory, { recursive: true, force: true });
});

async function withCore<T>(fn: (core: DataSource) => Promise<T>): Promise<T> {
  const core = await new DataSource(baseOptions).initialize();
  try {
    return await fn(core);
  } finally {
    await core.destroy();
  }
}

function tableNames(rows: { name: string }[]): string[] {
  return rows.map((row) => row.name).sort();
}

class CreatesOwnTable implements MigrationInterface {
  name = 'CreatesOwnTable1000000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ext_demo_event" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "userId" integer NOT NULL)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_demo_event_user" ON "ext_demo_event" ("userId") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ext_demo_event"`);
  }
}

class CreatesSecondOwnTable implements MigrationInterface {
  name = 'CreatesSecondOwnTable1000000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ext_demo_setting" ("key" varchar PRIMARY KEY NOT NULL)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ext_demo_setting"`);
  }
}

describe('extensionTablePrefix', () => {
  it('namespaces tables by extension id', () => {
    assert.strictEqual(
      extensionTablePrefix('watch-history'),
      'ext_watch-history_'
    );
  });

  it('names the tracking table under the same prefix', () => {
    assert.strictEqual(
      extensionMigrationsTableName('watch-history'),
      'ext_watch-history_migration'
    );
  });
});

describe('runExtensionMigrations', () => {
  it('applies an extension migration', async () => {
    const results = await runExtensionMigrations(
      [{ id: 'demo', migrations: [CreatesOwnTable] }],
      { baseOptions }
    );

    assert.deepStrictEqual(results, [
      {
        id: 'demo',
        migrations: ['CreatesOwnTable1000000000001'],
      },
    ]);

    await withCore(async (core) => {
      assert.ok(await core.createQueryRunner().getTable('ext_demo_event'));
    });
  });

  it('tracks applied migrations in its own table', async () => {
    await runExtensionMigrations(
      [{ id: 'demo', migrations: [CreatesOwnTable] }],
      { baseOptions }
    );

    await withCore(async (core) => {
      assert.deepStrictEqual(
        await core.query(`SELECT "name" FROM "ext_demo_migration"`),
        [{ name: 'CreatesOwnTable1000000000001' }]
      );
    });
  });

  it('leaves the core migrations table untouched', async () => {
    await runExtensionMigrations(
      [{ id: 'demo', migrations: [CreatesOwnTable] }],
      { baseOptions }
    );

    await withCore(async (core) => {
      assert.deepStrictEqual(
        await core.query(`SELECT * FROM "migrations"`),
        []
      );
    });
  });

  it('does not re-apply a migration on a second run', async () => {
    const extensions = [{ id: 'demo', migrations: [CreatesOwnTable] }];

    await runExtensionMigrations(extensions, { baseOptions });
    const second = await runExtensionMigrations(extensions, { baseOptions });

    assert.deepStrictEqual(second, [{ id: 'demo', migrations: [] }]);
  });

  it('applies only the pending migration when one is already recorded', async () => {
    await runExtensionMigrations(
      [{ id: 'demo', migrations: [CreatesOwnTable] }],
      { baseOptions }
    );

    const second = await runExtensionMigrations(
      [{ id: 'demo', migrations: [CreatesOwnTable, CreatesSecondOwnTable] }],
      { baseOptions }
    );

    assert.deepStrictEqual(second, [
      { id: 'demo', migrations: ['CreatesSecondOwnTable1000000000002'] },
    ]);
  });

  // Boot order is discover → setOptions → initialize → migrate, so the main
  // DataSource is already connected to this database by the time the runner
  // opens its own short-lived one.
  it('applies migrations while the main DataSource holds the database open', async () => {
    const main = await new DataSource(baseOptions).initialize();

    try {
      const [result] = await runExtensionMigrations(
        [{ id: 'demo', migrations: [CreatesOwnTable] }],
        { baseOptions }
      );

      assert.strictEqual(result.error, undefined);
      assert.ok(await main.createQueryRunner().getTable('ext_demo_event'));
    } finally {
      await main.destroy();
    }
  });

  it('no-ops on a later boot when the tables already exist', async () => {
    const extensions = [{ id: 'demo', migrations: [CreatesOwnTable] }];
    await runExtensionMigrations(extensions, { baseOptions });

    const main = await new DataSource(baseOptions).initialize();

    try {
      // Re-running against a database that already has the extension's tables
      // must not attempt to create them a second time.
      const [result] = await runExtensionMigrations(extensions, {
        baseOptions,
      });

      assert.strictEqual(result.error, undefined);
      assert.deepStrictEqual(result.migrations, []);
    } finally {
      await main.destroy();
    }
  });

  it('applies the pending migration after an earlier one failed', async () => {
    class Throws implements MigrationInterface {
      name = 'ThrowsThenFixed1000000000006';

      public async up(): Promise<void> {
        throw new Error('transient failure');
      }

      public async down(): Promise<void> {
        // no-op
      }
    }

    const failed = await runExtensionMigrations(
      [{ id: 'demo', migrations: [Throws] }],
      { baseOptions }
    );
    assert.ok(failed[0].error);

    // The failed migration was not recorded, so a later boot retries it.
    const retried = await runExtensionMigrations(
      [{ id: 'demo', migrations: [CreatesOwnTable] }],
      { baseOptions }
    );

    assert.deepStrictEqual(retried[0].migrations, [
      'CreatesOwnTable1000000000001',
    ]);
  });

  it('skips an extension with no migrations without creating a tracking table', async () => {
    const results = await runExtensionMigrations(
      [{ id: 'demo', migrations: [] }],
      {
        baseOptions,
      }
    );

    assert.deepStrictEqual(results, [{ id: 'demo', migrations: [] }]);

    await withCore(async (core) => {
      assert.strictEqual(
        await core.createQueryRunner().hasTable('ext_demo_migration'),
        false
      );
    });
  });

  it('runs with sqlite foreign keys disabled, as core migrations do', async () => {
    let pragma: unknown;

    class ReadsPragma implements MigrationInterface {
      name = 'ReadsPragma1000000000003';

      public async up(queryRunner: QueryRunner): Promise<void> {
        [{ foreign_keys: pragma }] =
          await queryRunner.query(`PRAGMA foreign_keys`);
        await queryRunner.query(
          `CREATE TABLE "ext_demo_event" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL)`
        );
      }

      public async down(): Promise<void> {
        // no-op
      }
    }

    await runExtensionMigrations([{ id: 'demo', migrations: [ReadsPragma] }], {
      baseOptions,
    });

    assert.strictEqual(pragma, 0);
  });

  it('supports the temporary_ table rewrite sqlite migrations use', async () => {
    class RewritesOwnTable implements MigrationInterface {
      name = 'RewritesOwnTable1000000000004';

      public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
          `CREATE TABLE "ext_demo_event" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL)`
        );
        await queryRunner.query(
          `CREATE TABLE "temporary_ext_demo_event" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "note" varchar)`
        );
        await queryRunner.query(
          `INSERT INTO "temporary_ext_demo_event"("id") SELECT "id" FROM "ext_demo_event"`
        );
        await queryRunner.query(`DROP TABLE "ext_demo_event"`);
        await queryRunner.query(
          `ALTER TABLE "temporary_ext_demo_event" RENAME TO "ext_demo_event"`
        );
      }

      public async down(): Promise<void> {
        // no-op
      }
    }

    const results = await runExtensionMigrations(
      [{ id: 'demo', migrations: [RewritesOwnTable] }],
      { baseOptions }
    );

    assert.strictEqual(results[0].error, undefined);

    await withCore(async (core) => {
      const table = await core.createQueryRunner().getTable('ext_demo_event');
      assert.deepStrictEqual(
        table?.columns.map((column) => column.name).sort(),
        ['id', 'note']
      );
    });
  });

  it('namespaces a hyphenated extension id', async () => {
    class CreatesHyphenatedTable implements MigrationInterface {
      name = 'CreatesHyphenatedTable1000000000005';

      public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
          `CREATE TABLE "ext_watch-history_event" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL)`
        );
      }

      public async down(): Promise<void> {
        // no-op
      }
    }

    const results = await runExtensionMigrations(
      [{ id: 'watch-history', migrations: [CreatesHyphenatedTable] }],
      { baseOptions }
    );

    assert.strictEqual(results[0].error, undefined);

    await withCore(async (core) => {
      assert.deepStrictEqual(
        await core.query(`SELECT "name" FROM "ext_watch-history_migration"`),
        [{ name: 'CreatesHyphenatedTable1000000000005' }]
      );
    });
  });
});

describe('runExtensionMigrations table prefix enforcement', () => {
  class CreatesForeignTable implements MigrationInterface {
    name = 'CreatesForeignTable1000000000010';

    public async up(queryRunner: QueryRunner): Promise<void> {
      await queryRunner.query(
        `CREATE TABLE "watch_event" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL)`
      );
    }

    public async down(): Promise<void> {
      // no-op
    }
  }

  it('rejects a migration creating a table outside its namespace', async () => {
    const [result] = await runExtensionMigrations(
      [{ id: 'demo', migrations: [CreatesForeignTable] }],
      { baseOptions }
    );

    assert.match(result.error?.message ?? '', /watch_event/);
    assert.match(result.error?.message ?? '', /ext_demo_/);
    assert.deepStrictEqual(result.migrations, []);
  });

  it('does not create the rejected table', async () => {
    await runExtensionMigrations(
      [{ id: 'demo', migrations: [CreatesForeignTable] }],
      { baseOptions }
    );

    await withCore(async (core) => {
      assert.strictEqual(
        await core.createQueryRunner().hasTable('watch_event'),
        false
      );
    });
  });

  it('rejects a migration creating another extensions table', async () => {
    class CreatesOtherExtensionTable implements MigrationInterface {
      name = 'CreatesOtherExtensionTable1000000000011';

      public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
          `CREATE TABLE "ext_other_event" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL)`
        );
      }

      public async down(): Promise<void> {
        // no-op
      }
    }

    const [result] = await runExtensionMigrations(
      [{ id: 'demo', migrations: [CreatesOtherExtensionTable] }],
      { baseOptions }
    );

    assert.match(result.error?.message ?? '', /ext_other_event/);
  });

  it('rejects a migration altering a core table', async () => {
    class AltersCoreTable implements MigrationInterface {
      name = 'AltersCoreTable1000000000012';

      public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
          `ALTER TABLE "user" ADD COLUMN "sneaky" varchar`
        );
      }

      public async down(): Promise<void> {
        // no-op
      }
    }

    const [result] = await runExtensionMigrations(
      [{ id: 'demo', migrations: [AltersCoreTable] }],
      { baseOptions }
    );

    assert.match(result.error?.message ?? '', /"user"/);

    await withCore(async (core) => {
      const table = await core.createQueryRunner().getTable('user');
      assert.deepStrictEqual(
        table?.columns.map((column) => column.name).sort(),
        ['email', 'id']
      );
    });
  });

  it('rejects a migration dropping a core table', async () => {
    class DropsCoreTable implements MigrationInterface {
      name = 'DropsCoreTable1000000000013';

      public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "user"`);
      }

      public async down(): Promise<void> {
        // no-op
      }
    }

    await runExtensionMigrations(
      [{ id: 'demo', migrations: [DropsCoreTable] }],
      { baseOptions }
    );

    await withCore(async (core) => {
      assert.strictEqual(await core.createQueryRunner().hasTable('user'), true);
    });
  });

  it('rejects a core table hidden behind a second statement', async () => {
    class SmugglesStatement implements MigrationInterface {
      name = 'SmugglesStatement1000000000014';

      public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
          `CREATE TABLE "ext_demo_event" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL); DROP TABLE "user"`
        );
      }

      public async down(): Promise<void> {
        // no-op
      }
    }

    const [result] = await runExtensionMigrations(
      [{ id: 'demo', migrations: [SmugglesStatement] }],
      { baseOptions }
    );

    assert.match(result.error?.message ?? '', /"user"/);
  });

  it('rejects an index created on a table outside its namespace', async () => {
    class IndexesCoreTable implements MigrationInterface {
      name = 'IndexesCoreTable1000000000015';

      public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
          `CREATE INDEX "IDX_demo_user_email" ON "user" ("email") `
        );
      }

      public async down(): Promise<void> {
        // no-op
      }
    }

    const [result] = await runExtensionMigrations(
      [{ id: 'demo', migrations: [IndexesCoreTable] }],
      { baseOptions }
    );

    assert.match(result.error?.message ?? '', /"user"/);
  });

  it('rejects DDL it cannot attribute to a table', async () => {
    class CreatesView implements MigrationInterface {
      name = 'CreatesView1000000000016';

      public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
          `CREATE VIEW "ext_demo_view" AS SELECT "id" FROM "user"`
        );
      }

      public async down(): Promise<void> {
        // no-op
      }
    }

    const [result] = await runExtensionMigrations(
      [{ id: 'demo', migrations: [CreatesView] }],
      { baseOptions }
    );

    assert.ok(result.error, 'expected unattributable DDL to be rejected');

    await withCore(async (core) => {
      assert.deepStrictEqual(
        tableNames(
          await core.query(
            `SELECT "name" FROM "sqlite_master" WHERE "type" = 'view'`
          )
        ),
        []
      );
    });
  });
});

describe('runExtensionMigrations failure handling', () => {
  class Throws implements MigrationInterface {
    name = 'Throws1000000000020';

    public async up(): Promise<void> {
      throw new Error('extension migration exploded');
    }

    public async down(): Promise<void> {
      // no-op
    }
  }

  it('reports a throwing migration instead of propagating it', async () => {
    const [result] = await runExtensionMigrations(
      [{ id: 'demo', migrations: [Throws] }],
      { baseOptions }
    );

    assert.strictEqual(result.id, 'demo');
    assert.match(result.error?.message ?? '', /extension migration exploded/);
    assert.deepStrictEqual(result.migrations, []);
  });

  it('reports a migration that fails against the database', async () => {
    class WritesBadSql implements MigrationInterface {
      name = 'WritesBadSql1000000000021';

      public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "ext_demo_event" (nonsense`);
      }

      public async down(): Promise<void> {
        // no-op
      }
    }

    const [result] = await runExtensionMigrations(
      [{ id: 'demo', migrations: [WritesBadSql] }],
      { baseOptions }
    );

    assert.ok(result.error, 'expected the sqlite syntax error to be reported');
  });

  it('still runs the remaining extensions after one fails', async () => {
    const results = await runExtensionMigrations(
      [
        { id: 'broken', migrations: [Throws] },
        { id: 'demo', migrations: [CreatesOwnTable] },
      ],
      { baseOptions }
    );

    assert.deepStrictEqual(
      results.map((result) => [result.id, result.error != null]),
      [
        ['broken', true],
        ['demo', false],
      ]
    );

    await withCore(async (core) => {
      assert.ok(await core.createQueryRunner().getTable('ext_demo_event'));
    });
  });

  it('destroys the short-lived DataSource even when a migration fails', async () => {
    const destroy = mock.method(DataSource.prototype, 'destroy');

    await runExtensionMigrations([{ id: 'broken', migrations: [Throws] }], {
      baseOptions,
    });

    assert.strictEqual(destroy.mock.callCount(), 1);
  });

  it('reports an extension whose DataSource cannot be initialized', async () => {
    const [result] = await runExtensionMigrations(
      [{ id: 'demo', migrations: [CreatesOwnTable] }],
      {
        // A directory is not an openable sqlite database.
        baseOptions: {
          ...baseOptions,
          database: directory,
        } as DataSourceOptions,
      }
    );

    assert.ok(result.error, 'expected the failed connection to be reported');
  });

  it('runs extensions one at a time', async () => {
    const events: string[] = [];

    const migrationFor = (id: string) =>
      class Slow implements MigrationInterface {
        name = `Slow_${id}_1000000000030`;

        public async up(queryRunner: QueryRunner): Promise<void> {
          events.push(`start:${id}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
          await queryRunner.query(
            `CREATE TABLE "ext_${id}_event" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL)`
          );
          events.push(`end:${id}`);
        }

        public async down(): Promise<void> {
          // no-op
        }
      };

    await runExtensionMigrations(
      [
        { id: 'first', migrations: [migrationFor('first')] },
        { id: 'second', migrations: [migrationFor('second')] },
      ],
      { baseOptions }
    );

    assert.deepStrictEqual(events, [
      'start:first',
      'end:first',
      'start:second',
      'end:second',
    ]);
  });
});
