export interface IAuthUser {
  id: string;
  userType: string;
  userRole?: string | null;
  tenantId?: string | null;
}

export type SupeEntityType = 'salesman' | 'retailer' | 'sku' | 'beat' | 'distributor';

export interface IPaginatedResponse<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
