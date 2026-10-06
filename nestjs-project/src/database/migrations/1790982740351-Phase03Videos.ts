import { MigrationInterface, QueryRunner } from 'typeorm';

export class Phase03Videos1790982740351 implements MigrationInterface {
  name = 'Phase03Videos1790982740351';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('DRAFT', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "nano_id" character varying(21) NOT NULL, "title" character varying(100), "description" text, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'DRAFT', "channel_id" uuid NOT NULL, "duration_seconds" integer, "file_key" character varying(255), "thumbnail_key" character varying(255), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_be324ccc3337bed70fdb489fada" UNIQUE ("nano_id"), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id")); COMMENT ON COLUMN "videos"."duration_seconds" IS 'Duration in seconds'`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}
