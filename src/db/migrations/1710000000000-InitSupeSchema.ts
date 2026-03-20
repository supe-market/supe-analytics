import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitSupeSchema1710000000000 implements MigrationInterface {
  name = 'InitSupeSchema1710000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create extension if not exists pgcrypto;

      create table if not exists tenants (
        id bigserial primary key,
        tenant_code text not null unique,
        tenant_name text not null,
        active boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create table if not exists import_batches (
        id bigserial primary key,
        batch_uuid uuid not null unique default gen_random_uuid(),
        tenant_id bigint not null references tenants(id),
        source_file_name text not null,
        source_file_type text,
        source_sheet_name text,
        file_checksum text,
        file_object_key text,
        total_rows int not null default 0,
        total_columns int not null default 0,
        valid_rows int not null default 0,
        rejected_rows int not null default 0,
        import_status text not null default 'UPLOADED',
        notes text,
        imported_at timestamptz not null default now(),
        created_at timestamptz not null default now()
      );
      create index if not exists idx_import_batches_tenant on import_batches(tenant_id);

      create table if not exists raw_records (
        id bigserial primary key,
        import_batch_id bigint not null references import_batches(id) on delete cascade,
        source_row_number int not null,
        raw_row_json jsonb not null,
        created_at timestamptz not null default now(),
        unique (import_batch_id, source_row_number)
      );
      create index if not exists idx_raw_records_batch on raw_records(import_batch_id);
      create index if not exists idx_raw_records_json on raw_records using gin(raw_row_json);

      create table if not exists distributors (
        id bigserial primary key,
        tenant_id bigint not null references tenants(id),
        distributor_code text not null,
        distributor_name text not null,
        zone text,
        region text,
        area text,
        active boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (tenant_id, distributor_code)
      );
      create index if not exists idx_distributors_tenant on distributors(tenant_id);
      create index if not exists idx_distributors_name on distributors(distributor_name);

      create table if not exists beats (
        id bigserial primary key,
        tenant_id bigint not null references tenants(id),
        beat_code text not null,
        beat_name text not null,
        distributor_id bigint references distributors(id),
        zone text,
        region text,
        area text,
        active boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (tenant_id, beat_code)
      );
      create index if not exists idx_beats_tenant on beats(tenant_id);
      create index if not exists idx_beats_name on beats(beat_name);

      create table if not exists salesmen (
        id bigserial primary key,
        tenant_id bigint not null references tenants(id),
        salesman_code text not null,
        external_salesman_id text,
        employee_code text,
        salesman_name text not null,
        phone_number text,
        zone text,
        region text,
        area text,
        distributor_id bigint references distributors(id),
        active boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (tenant_id, salesman_code)
      );
      create index if not exists idx_salesmen_tenant on salesmen(tenant_id);
      create index if not exists idx_salesmen_name on salesmen(salesman_name);

      create table if not exists outlets (
        id bigserial primary key,
        external_outlet_code text,
        outlet_name text not null,
        mobile_number text,
        gst_number text,
        address_line1 text,
        address_line2 text,
        pincode text,
        latitude numeric(10,7),
        longitude numeric(10,7),
        zone text,
        region text,
        area text,
        active boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists idx_outlets_name on outlets(outlet_name);
      create index if not exists idx_outlets_mobile on outlets(mobile_number);
      create index if not exists idx_outlets_gst on outlets(gst_number);

      create table if not exists beat_outlets (
        id bigserial primary key,
        tenant_id bigint not null references tenants(id),
        beat_id bigint not null references beats(id) on delete cascade,
        outlet_id bigint not null references outlets(id) on delete cascade,
        active boolean not null default true,
        assigned_at timestamptz not null default now(),
        removed_at timestamptz,
        assigned_by text,
        removed_by text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (tenant_id, beat_id, outlet_id)
      );
      create index if not exists idx_beat_outlets_tenant_beat on beat_outlets(tenant_id, beat_id);
      create index if not exists idx_beat_outlets_tenant_outlet on beat_outlets(tenant_id, outlet_id);
      create unique index if not exists uq_beat_outlets_active_per_outlet on beat_outlets(tenant_id, outlet_id) where active = true;

      create table if not exists tenant_outlets (
        id bigserial primary key,
        tenant_id bigint not null references tenants(id),
        outlet_id bigint not null references outlets(id),
        tenant_outlet_code text not null,
        salesman_id bigint references salesmen(id),
        distributor_id bigint references distributors(id),
        servicing_status text,
        active boolean not null default true,
        first_order_date date,
        last_order_date date,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (tenant_id, outlet_id),
        unique (tenant_id, tenant_outlet_code)
      );
      create index if not exists idx_tenant_outlets_tenant on tenant_outlets(tenant_id);
      create index if not exists idx_tenant_outlets_outlet on tenant_outlets(outlet_id);

      create table if not exists brands (
        id bigserial primary key,
        tenant_id bigint not null references tenants(id),
        brand_code text,
        brand_name text not null,
        active boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (tenant_id, brand_name)
      );
      create index if not exists idx_brands_tenant on brands(tenant_id);
      create index if not exists idx_brands_name on brands(brand_name);

      create table if not exists skus (
        id bigserial primary key,
        tenant_id bigint not null references tenants(id),
        sku_code text not null,
        name text not null,
        brand_id bigint references brands(id),
        hsn_code text,
        mrp numeric(12,2),
        discount_amount numeric(12,2),
        discount_percent numeric(7,2),
        rate numeric(12,2),
        sgst_percent numeric(7,2),
        sgst_amount numeric(12,2),
        cgst_percent numeric(7,2),
        cgst_amount numeric(12,2),
        amount numeric(12,2),
        weight numeric(12,3),
        length_cm numeric(10,2),
        width_cm numeric(10,2),
        height_cm numeric(10,2),
        igst_percent numeric(7,2),
        igst_amount numeric(12,2),
        active boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (tenant_id, sku_code)
      );
      create index if not exists idx_skus_tenant on skus(tenant_id);
      create index if not exists idx_skus_name on skus(name);

      create table if not exists sales_orders (
        id bigserial primary key,
        tenant_id bigint not null references tenants(id),
        import_batch_id bigint references import_batches(id),
        external_order_id text,
        external_invoice_no text,
        external_awb_no text,
        order_punched_at timestamptz,
        order_sale_date date,
        outlet_id bigint not null references outlets(id),
        tenant_outlet_id bigint references tenant_outlets(id),
        beat_id bigint references beats(id),
        salesman_id bigint references salesmen(id),
        distributor_id bigint references distributors(id),
        gross_amount numeric(14,2),
        discount_amount numeric(14,2),
        tax_amount numeric(14,2),
        net_amount numeric(14,2),
        collections_amount numeric(14,2),
        outstanding_amount numeric(14,2),
        decided_margin_amount numeric(14,2),
        remarks text,
        first_source_record_id bigint references raw_records(id),
        latest_source_record_id bigint references raw_records(id),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists idx_sales_orders_tenant on sales_orders(tenant_id);
      create unique index if not exists uq_sales_orders_tenant_invoice on sales_orders(tenant_id, external_invoice_no) where external_invoice_no is not null;
      create unique index if not exists uq_sales_orders_tenant_order on sales_orders(tenant_id, external_order_id) where external_order_id is not null;
      create index if not exists idx_sales_orders_date on sales_orders(order_sale_date);
      create index if not exists idx_sales_orders_outlet on sales_orders(outlet_id);
      create index if not exists idx_sales_orders_beat on sales_orders(beat_id);
      create index if not exists idx_sales_orders_salesman on sales_orders(salesman_id);
      create index if not exists idx_sales_orders_distributor on sales_orders(distributor_id);
      create index if not exists idx_sales_orders_awb on sales_orders(external_awb_no);
      create index if not exists idx_sales_orders_invoice on sales_orders(external_invoice_no);

      create table if not exists sales_order_items (
        id bigserial primary key,
        sales_order_id bigint not null references sales_orders(id) on delete cascade,
        sku_id bigint not null references skus(id),
        external_line_id text,
        ordered_quantity numeric(12,3) not null,
        rate numeric(12,2),
        discount_amount numeric(12,2),
        discount_percent numeric(7,2),
        sgst_percent numeric(7,2),
        sgst_amount numeric(12,2),
        cgst_percent numeric(7,2),
        cgst_amount numeric(12,2),
        igst_percent numeric(7,2),
        igst_amount numeric(12,2),
        tax_amount numeric(12,2),
        amount numeric(12,2),
        first_source_record_id bigint references raw_records(id),
        latest_source_record_id bigint references raw_records(id),
        created_at timestamptz not null default now()
      );
      create index if not exists idx_sales_order_items_order on sales_order_items(sales_order_id);
      create unique index if not exists uq_sales_order_items_order_line on sales_order_items(sales_order_id, external_line_id) where external_line_id is not null;
      create index if not exists idx_sales_order_items_sku on sales_order_items(sku_id);

      create table if not exists order_payments (
        id bigserial primary key,
        tenant_id bigint not null references tenants(id),
        sales_order_id bigint not null references sales_orders(id) on delete cascade,
        payment_date date,
        payment_mode text,
        amount numeric(14,2),
        external_ref text,
        source_record_id bigint references raw_records(id),
        created_at timestamptz not null default now()
      );
      create index if not exists idx_order_payments_order on order_payments(sales_order_id);
      create index if not exists idx_order_payments_date on order_payments(payment_date);
      create index if not exists idx_order_payments_mode on order_payments(payment_mode);

      create table if not exists canonical_record_sources (
        id bigserial primary key,
        entity_name text not null,
        entity_pk bigint not null,
        raw_record_id bigint not null references raw_records(id) on delete cascade,
        role text,
        created_at timestamptz not null default now()
      );
      create index if not exists idx_canonical_record_sources_entity on canonical_record_sources(entity_name, entity_pk);

      create table if not exists entity_metric_snapshots (
        id bigserial primary key,
        tenant_id bigint not null references tenants(id),
        entity_type text not null,
        entity_id text not null,
        entity_name text,
        metric_key text not null,
        metric_label text,
        metric_unit text,
        time_granularity text not null,
        snapshot_date date not null,
        period_start_date date,
        period_end_date date,
        zone text,
        region text,
        area text,
        metric_value numeric(18,4) not null,
        previous_value numeric(18,4),
        numerator numeric(18,4),
        denominator numeric(18,4),
        metadata jsonb,
        created_at timestamptz not null default now()
      );
      create index if not exists idx_entity_metric_snapshots_lookup on entity_metric_snapshots(tenant_id, entity_type, metric_key, snapshot_date);
      create index if not exists idx_entity_metric_snapshots_entity on entity_metric_snapshots(entity_type, entity_id);

      create table if not exists signal_definitions (
        id bigserial primary key,
        entity_type text not null,
        signal_key text not null,
        metric_key text not null,
        comparison_operator text not null,
        value_type text not null,
        unit_label text,
        window_type text not null default 'MTD',
        default_severity text not null default 'warning',
        active boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (entity_type, signal_key)
      );

      create table if not exists tenant_signal_thresholds (
        id bigserial primary key,
        tenant_id bigint not null references tenants(id),
        signal_definition_id bigint not null references signal_definitions(id) on delete cascade,
        zone text not null default 'NATIONAL',
        threshold_value numeric(18,4) not null,
        is_enabled boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (tenant_id, signal_definition_id, zone)
      );
      create index if not exists idx_tenant_signal_thresholds_lookup on tenant_signal_thresholds(tenant_id, signal_definition_id, zone);

      create table if not exists entity_signals (
        id bigserial primary key,
        tenant_id bigint not null references tenants(id),
        signal_definition_id bigint not null references signal_definitions(id),
        entity_type text not null,
        entity_id text not null,
        entity_name text,
        severity text not null,
        signal_key text not null,
        headline text not null,
        description text,
        metric_key text,
        observed_value numeric(18,4),
        threshold_value numeric(18,4),
        comparison_operator text,
        breach_amount numeric(18,4),
        zone text,
        region text,
        area text,
        window_start_date date,
        window_end_date date,
        detected_at timestamptz not null default now(),
        metadata jsonb,
        created_at timestamptz not null default now()
      );
      create index if not exists idx_entity_signals_lookup on entity_signals(tenant_id, entity_type, severity, detected_at);
      create index if not exists idx_entity_signals_entity on entity_signals(entity_type, entity_id);

      create table if not exists compare_presets (
        id bigserial primary key,
        tenant_id bigint not null references tenants(id),
        preset_name text not null,
        compare_dimension text not null,
        selected_metrics jsonb not null,
        selected_entities jsonb not null,
        filters jsonb,
        created_by text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists idx_compare_presets_tenant on compare_presets(tenant_id);

      create table if not exists compare_runs (
        id bigserial primary key,
        tenant_id bigint not null references tenants(id),
        compare_dimension text not null,
        period_label text,
        snapshot_date date,
        filters jsonb,
        selected_metrics jsonb not null,
        selected_entities jsonb not null,
        run_status text not null default 'COMPLETED',
        created_by text,
        created_at timestamptz not null default now()
      );

      create table if not exists compare_results (
        id bigserial primary key,
        compare_run_id bigint not null references compare_runs(id) on delete cascade,
        tenant_id bigint not null references tenants(id),
        compare_dimension text not null,
        entity_id text not null,
        entity_name text not null,
        zone text,
        region text,
        area text,
        metric_key text not null,
        metric_value numeric(18,4),
        percentile_rank numeric(7,2),
        index_to_average numeric(18,4),
        gap_to_top numeric(18,4),
        gap_to_average numeric(18,4),
        composite_score numeric(18,4),
        metadata jsonb,
        created_at timestamptz not null default now()
      );
      create index if not exists idx_compare_results_run on compare_results(compare_run_id);
      create index if not exists idx_compare_results_lookup on compare_results(tenant_id, compare_dimension, metric_key);

      create table if not exists people (
        id bigserial primary key,
        tenant_id bigint not null references tenants(id),
        person_code text,
        full_name text not null,
        role_code text,
        role_name text,
        zone text,
        region text,
        area text,
        manager_person_id bigint references people(id),
        active boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (tenant_id, person_code)
      );
      create index if not exists idx_people_tenant on people(tenant_id);
      create index if not exists idx_people_manager on people(manager_person_id);

      create table if not exists target_definitions (
        id bigserial primary key,
        tenant_id bigint not null references tenants(id),
        target_key text not null,
        target_name text not null,
        metric_key text not null,
        metric_unit text,
        comparison_operator text not null,
        active boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (tenant_id, target_key)
      );

      create table if not exists target_assignments (
        id bigserial primary key,
        tenant_id bigint not null references tenants(id),
        person_id bigint not null references people(id),
        target_definition_id bigint not null references target_definitions(id),
        assignment_name text,
        period_granularity text not null,
        period_start_date date not null,
        period_end_date date not null,
        target_value numeric(18,4) not null,
        stretch_value numeric(18,4),
        weightage numeric(8,2),
        scope_level text not null default 'national',
        scope_value text not null default 'all_india',
        baseline_value numeric(18,4) not null default 0,
        status text not null default 'active',
        created_by text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists idx_target_assignments_person on target_assignments(person_id);
      create index if not exists idx_target_assignments_period on target_assignments(period_start_date, period_end_date);
      create index if not exists idx_target_assignments_scope on target_assignments(scope_level, scope_value);

      create table if not exists target_progress_snapshots (
        id bigserial primary key,
        tenant_id bigint not null references tenants(id),
        target_assignment_id bigint not null references target_assignments(id) on delete cascade,
        person_id bigint not null references people(id),
        snapshot_date date not null,
        actual_value numeric(18,4) not null,
        target_value numeric(18,4) not null,
        progress_pct numeric(8,2),
        status_label text,
        variance_value numeric(18,4),
        variance_pct numeric(8,2),
        metadata jsonb,
        created_at timestamptz not null default now()
      );
      create index if not exists idx_target_progress_assignment on target_progress_snapshots(target_assignment_id);
      create index if not exists idx_target_progress_person on target_progress_snapshots(person_id);

      alter table entity_metric_snapshots
      add constraint chk_entity_metric_snapshots_granularity
      check (time_granularity in ('day', 'week', 'month'));

      alter table signal_definitions
      add constraint chk_signal_definitions_operator
      check (comparison_operator in ('LT', 'LTE', 'GT', 'GTE'));

      alter table signal_definitions
      add constraint chk_signal_definitions_value_type
      check (value_type in ('percent', 'currency', 'integer', 'decimal', 'days', 'number'));

      alter table signal_definitions
      add constraint chk_signal_definitions_severity
      check (default_severity in ('critical', 'warning', 'opportunity'));

      alter table signal_definitions
      add constraint chk_signal_definitions_window
      check (window_type in ('MTD', 'ROLLING_7D', 'ROLLING_30D', 'QTD', 'YTD'));

      alter table tenant_signal_thresholds
      add constraint chk_tenant_signal_thresholds_zone_upper
      check (zone = upper(zone));

      alter table entity_signals
      add constraint chk_entity_signals_severity
      check (severity in ('critical', 'warning', 'opportunity'));

      alter table compare_runs
      add constraint chk_compare_runs_dimension
      check (compare_dimension in ('geography', 'distributor', 'sku'));

      alter table target_assignments
      add constraint chk_target_assignments_granularity
      check (period_granularity in ('month', 'quarter'));

      alter table target_assignments
      add constraint chk_target_assignments_status
      check (status in ('active', 'completed', 'cancelled'));
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop table if exists target_progress_snapshots;
      drop table if exists target_assignments;
      drop table if exists target_definitions;
      drop table if exists people;
      drop table if exists compare_results;
      drop table if exists compare_runs;
      drop table if exists compare_presets;
      drop table if exists entity_signals;
      drop table if exists tenant_signal_thresholds;
      drop table if exists signal_definitions;
      drop table if exists entity_metric_snapshots;
      drop table if exists canonical_record_sources;
      drop table if exists order_payments;
      drop table if exists sales_order_items;
      drop table if exists sales_orders;
      drop table if exists skus;
      drop table if exists brands;
      drop table if exists tenant_outlets;
      drop table if exists beat_outlets;
      drop table if exists outlets;
      drop table if exists salesmen;
      drop table if exists beats;
      drop table if exists distributors;
      drop table if exists raw_records;
      drop table if exists import_batches;
      drop table if exists tenants;
    `);
  }
}
