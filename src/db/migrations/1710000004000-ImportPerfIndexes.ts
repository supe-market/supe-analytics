import { MigrationInterface, QueryRunner } from 'typeorm';

export class ImportPerfIndexes1710000004000 implements MigrationInterface {
  name = 'ImportPerfIndexes1710000004000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // order_payments: the payment matching query looks up by external_ref and by
    // composite (date, mode, amount) when no ref exists. Without these indexes
    // the upsert does a full table scan per resolved row.
    await queryRunner.query(`
      create index if not exists idx_order_payments_tenant_ref
        on order_payments(tenant_id, external_ref)
        where external_ref is not null;

      create index if not exists idx_order_payments_tenant_order
        on order_payments(tenant_id, sales_order_id);

      create index if not exists idx_order_payments_composite_match
        on order_payments(sales_order_id, payment_date, payment_mode, amount)
        where external_ref is null;

      -- sales_orders: the order identity join already has unique indexes on
      -- (tenant_id, external_invoice_no) and (tenant_id, external_order_id)
      -- from the init migration. Ensure they exist as a safety net.
      create index if not exists idx_sales_orders_tenant_invoice
        on sales_orders(tenant_id, external_invoice_no)
        where external_invoice_no is not null;

      create index if not exists idx_sales_orders_tenant_order_id
        on sales_orders(tenant_id, external_order_id)
        where external_order_id is not null;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop index if exists idx_order_payments_tenant_ref;
      drop index if exists idx_order_payments_tenant_order;
      drop index if exists idx_order_payments_composite_match;
      drop index if exists idx_sales_orders_tenant_invoice;
      drop index if exists idx_sales_orders_tenant_order_id;
    `);
  }
}
