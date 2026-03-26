import { MigrationInterface, QueryRunner } from 'typeorm';

export class AsyncImportPipeline1710000002000 implements MigrationInterface {
  name = 'AsyncImportPipeline1710000002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table import_batches
        add column if not exists error_count int not null default 0,
        add column if not exists started_at timestamptz,
        add column if not exists completed_at timestamptz,
        add column if not exists processed_by text;

      create table if not exists import_batch_errors (
        id bigserial primary key,
        import_batch_id bigint not null references import_batches(id) on delete cascade,
        row_number int not null default 0,
        s_no text,
        column_name text not null,
        message text not null,
        phase text not null,
        created_at timestamptz not null default now()
      );

      create index if not exists idx_import_batch_errors_batch on import_batch_errors(import_batch_id, id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop table if exists import_batch_errors;

      alter table import_batches
        drop column if exists processed_by,
        drop column if exists completed_at,
        drop column if exists started_at,
        drop column if exists error_count;
    `);
  }
}
