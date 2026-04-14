import { MigrationInterface, QueryRunner } from 'typeorm';

export class SalesmanEmployeeCodeIdentity1710000005000 implements MigrationInterface {
  name = 'SalesmanEmployeeCodeIdentity1710000005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Fill any pre-existing nulls so we can add NOT NULL
    await queryRunner.query(`
      UPDATE salesmen SET employee_code = 'SYS_' || id::text WHERE employee_code IS NULL
    `);
    await queryRunner.query(`ALTER TABLE salesmen ALTER COLUMN employee_code SET NOT NULL`);

    // Swap the unique identity from salesman_code → employee_code
    await queryRunner.query(`ALTER TABLE salesmen DROP CONSTRAINT salesmen_tenant_id_salesman_code_key`);
    await queryRunner.query(`ALTER TABLE salesmen ADD CONSTRAINT salesmen_tenant_id_employee_code_key UNIQUE (tenant_id, employee_code)`);

    // salesman_code is now informational — no longer required
    await queryRunner.query(`ALTER TABLE salesmen ALTER COLUMN salesman_code DROP NOT NULL`);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_salesmen_employee_code ON salesmen(tenant_id, employee_code)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_salesmen_employee_code`);
    await queryRunner.query(`ALTER TABLE salesmen DROP CONSTRAINT salesmen_tenant_id_employee_code_key`);
    await queryRunner.query(`ALTER TABLE salesmen ALTER COLUMN salesman_code SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE salesmen ADD CONSTRAINT salesmen_tenant_id_salesman_code_key UNIQUE (tenant_id, salesman_code)`);
    await queryRunner.query(`ALTER TABLE salesmen ALTER COLUMN employee_code DROP NOT NULL`);
  }
}
