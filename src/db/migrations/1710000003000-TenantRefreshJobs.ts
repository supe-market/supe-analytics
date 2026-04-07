import { MigrationInterface, QueryRunner } from 'typeorm';

export class TenantRefreshJobs1710000003000 implements MigrationInterface {
  name = 'TenantRefreshJobs1710000003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table if not exists tenant_refresh_jobs (
        id bigserial primary key,
        tenant_id bigint not null references tenants(id) on delete cascade,
        status text not null default 'QUEUED',
        trigger_metadata jsonb,
        error_text text,
        rerun_requested boolean not null default false,
        requested_at timestamptz not null default now(),
        started_at timestamptz,
        completed_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create index if not exists idx_tenant_refresh_jobs_tenant on tenant_refresh_jobs(tenant_id, requested_at desc);
      create index if not exists idx_tenant_refresh_jobs_status on tenant_refresh_jobs(status, requested_at asc);
      create unique index if not exists uq_tenant_refresh_jobs_active
        on tenant_refresh_jobs(tenant_id)
        where status in ('QUEUED', 'RUNNING');

      create table if not exists tenant_refresh_job_imports (
        id bigserial primary key,
        refresh_job_id bigint not null references tenant_refresh_jobs(id) on delete cascade,
        import_batch_id bigint not null references import_batches(id) on delete cascade,
        created_at timestamptz not null default now(),
        unique (import_batch_id),
        unique (refresh_job_id, import_batch_id)
      );

      create index if not exists idx_tenant_refresh_job_imports_refresh on tenant_refresh_job_imports(refresh_job_id, created_at asc);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop table if exists tenant_refresh_job_imports;
      drop table if exists tenant_refresh_jobs;
    `);
  }
}
