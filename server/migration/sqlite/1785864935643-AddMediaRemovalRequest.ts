import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMediaRemovalRequest1785864935643 implements MigrationInterface {
  name = 'AddMediaRemovalRequest1785864935643';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "media_removal_request" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "status" integer NOT NULL, "is4k" boolean NOT NULL DEFAULT (0), "type" varchar NOT NULL, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "mediaId" integer, "requestedById" integer, "modifiedById" integer, CONSTRAINT "FK_78decd4e1901d80cfdce43b079f" FOREIGN KEY ("mediaId") REFERENCES "media" ("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "FK_148182cef7f27b27b1fdacd7de1" FOREIGN KEY ("requestedById") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "FK_34c6963994828cb30c9b2798dfa" FOREIGN KEY ("modifiedById") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_64e0da8892d7f8aabce7198097" ON "media_removal_request" ("status") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_78decd4e1901d80cfdce43b079" ON "media_removal_request" ("mediaId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_148182cef7f27b27b1fdacd7de" ON "media_removal_request" ("requestedById") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_34c6963994828cb30c9b2798df" ON "media_removal_request" ("modifiedById") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_34c6963994828cb30c9b2798df"`);
    await queryRunner.query(`DROP INDEX "IDX_148182cef7f27b27b1fdacd7de"`);
    await queryRunner.query(`DROP INDEX "IDX_78decd4e1901d80cfdce43b079"`);
    await queryRunner.query(`DROP INDEX "IDX_64e0da8892d7f8aabce7198097"`);
    await queryRunner.query(`DROP TABLE "media_removal_request"`);
  }
}
