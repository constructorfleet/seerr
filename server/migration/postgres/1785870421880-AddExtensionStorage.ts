import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddExtensionStorage1785870421880 implements MigrationInterface {
  name = 'AddExtensionStorage1785870421880';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ext_permission" ("userId" integer NOT NULL, "permission" character varying NOT NULL, CONSTRAINT "PK_f94551ee37acd36694dbb078821" PRIMARY KEY ("userId", "permission"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_08f1492ae60d00ba78047ee0e0" ON "ext_permission" ("userId") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_996f20880c401f679a05cc2f4d" ON "ext_permission" ("permission") `
    );
    await queryRunner.query(
      `CREATE TABLE "ext_notification_subscription" ("userId" integer NOT NULL, "notificationType" character varying NOT NULL, "agents" text, CONSTRAINT "PK_d8f563ff6ebce7ed014ac239c9e" PRIMARY KEY ("userId", "notificationType"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_34f15a5374c3798b39a8a328c5" ON "ext_notification_subscription" ("userId") `
    );
    await queryRunner.query(
      `CREATE TABLE "ext_kv" ("extensionId" character varying NOT NULL, "key" character varying NOT NULL, "value" text, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_6e12bb7ca5c1c228663d2147a31" PRIMARY KEY ("extensionId", "key"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_be323bc88ca0615dcd0f205afb" ON "ext_kv" ("extensionId") `
    );
    await queryRunner.query(
      `ALTER TABLE "ext_permission" ADD CONSTRAINT "FK_08f1492ae60d00ba78047ee0e06" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "ext_notification_subscription" ADD CONSTRAINT "FK_34f15a5374c3798b39a8a328c5a" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ext_notification_subscription" DROP CONSTRAINT "FK_34f15a5374c3798b39a8a328c5a"`
    );
    await queryRunner.query(
      `ALTER TABLE "ext_permission" DROP CONSTRAINT "FK_08f1492ae60d00ba78047ee0e06"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_be323bc88ca0615dcd0f205afb"`
    );
    await queryRunner.query(`DROP TABLE "ext_kv"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_34f15a5374c3798b39a8a328c5"`
    );
    await queryRunner.query(`DROP TABLE "ext_notification_subscription"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_996f20880c401f679a05cc2f4d"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_08f1492ae60d00ba78047ee0e0"`
    );
    await queryRunner.query(`DROP TABLE "ext_permission"`);
  }
}
