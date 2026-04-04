import type { DataSource } from 'typeorm';
import { SupeV1Service } from '../modules/v1/service';

export type TenantRecord = {
  id: number;
  tenantCode?: string;
};

export type TenantRefreshResult = Awaited<ReturnType<SupeV1Service['refreshTenantState']>>;

export async function refreshTenantState(
  db: DataSource,
  tenant: TenantRecord,
  triggeredBy: string
): Promise<TenantRefreshResult> {
  const service = new SupeV1Service(db);
  return service.refreshTenantState(tenant.id, triggeredBy);
}
