import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddExtensionStorage1785870387498 implements MigrationInterface {
  name = 'AddExtensionStorage1785870387498';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ext_permission" ("userId" integer NOT NULL, "permission" varchar NOT NULL, CONSTRAINT "FK_08f1492ae60d00ba78047ee0e06" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE NO ACTION, PRIMARY KEY ("userId", "permission"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_08f1492ae60d00ba78047ee0e0" ON "ext_permission" ("userId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_996f20880c401f679a05cc2f4d" ON "ext_permission" ("permission") `
    );
    await queryRunner.query(
      `CREATE TABLE "ext_notification_subscription" ("userId" integer NOT NULL, "notificationType" varchar NOT NULL, "agents" text, CONSTRAINT "FK_34f15a5374c3798b39a8a328c5a" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE NO ACTION, PRIMARY KEY ("userId", "notificationType"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_34f15a5374c3798b39a8a328c5" ON "ext_notification_subscription" ("userId") `
    );
    await queryRunner.query(
      `CREATE TABLE "ext_kv" ("extensionId" varchar NOT NULL, "key" varchar NOT NULL, "value" text, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), PRIMARY KEY ("extensionId", "key"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_be323bc88ca0615dcd0f205afb" ON "ext_kv" ("extensionId") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_be323bc88ca0615dcd0f205afb"`);
    await queryRunner.query(`DROP TABLE "ext_kv"`);
    await queryRunner.query(`DROP INDEX "IDX_34f15a5374c3798b39a8a328c5"`);
    await queryRunner.query(`DROP TABLE "ext_notification_subscription"`);
    await queryRunner.query(`DROP INDEX "IDX_996f20880c401f679a05cc2f4d"`);
    await queryRunner.query(`DROP INDEX "IDX_08f1492ae60d00ba78047ee0e0"`);
    await queryRunner.query(`DROP TABLE "ext_permission"`);
  }
}
