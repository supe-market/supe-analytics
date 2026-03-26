import { MigrationInterface, QueryRunner } from 'typeorm';

export class ActionWorkflow1710000001000 implements MigrationInterface {
  name = 'ActionWorkflow1710000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table if not exists actions (
        id bigserial primary key,
        tenant_id bigint not null references tenants(id),
        type text not null,
        title text not null,
        status text not null default 'draft',
        source_kind text not null default 'manual',
        source_key text,
        source_entity_type text,
        source_entity_id text,
        source_entity_name text,
        audience_type text,
        payload jsonb not null default '{}'::jsonb,
        delivery_summary jsonb not null default '{}'::jsonb,
        created_by text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists idx_actions_tenant_status on actions(tenant_id, status, created_at desc);
      create index if not exists idx_actions_source_key on actions(tenant_id, source_key);

      create table if not exists action_targets (
        id bigserial primary key,
        action_id bigint not null references actions(id) on delete cascade,
        entity_type text not null,
        entity_id text not null,
        entity_name text,
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );
      create index if not exists idx_action_targets_action on action_targets(action_id);

      create table if not exists action_events (
        id bigserial primary key,
        tenant_id bigint not null references tenants(id),
        action_id bigint not null references actions(id) on delete cascade,
        event_type text not null,
        label text not null,
        detail text,
        payload jsonb not null default '{}'::jsonb,
        created_by text,
        created_at timestamptz not null default now()
      );
      create index if not exists idx_action_events_tenant_created on action_events(tenant_id, created_at desc);
      create index if not exists idx_action_events_action on action_events(action_id, created_at desc);

      create table if not exists action_tasks (
        id bigserial primary key,
        tenant_id bigint not null references tenants(id),
        action_id bigint references actions(id) on delete cascade,
        assignee text not null,
        instruction text not null,
        deadline date,
        entity_type text,
        entity_id text,
        entity_name text,
        status text not null default 'open',
        created_by text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists idx_action_tasks_tenant_status on action_tasks(tenant_id, status, created_at desc);

      alter table entity_signals
      add column if not exists source_key text;
      alter table entity_signals
      add column if not exists action_state text not null default 'new';
      create index if not exists idx_entity_signals_source_key on entity_signals(tenant_id, source_key);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop index if exists idx_entity_signals_source_key;
      alter table entity_signals drop column if exists action_state;
      alter table entity_signals drop column if exists source_key;

      drop table if exists action_tasks;
      drop table if exists action_events;
      drop table if exists action_targets;
      drop table if exists actions;
    `);
  }
}
