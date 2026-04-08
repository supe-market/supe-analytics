import { createHash } from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { DataSource, QueryRunner } from 'typeorm';
import * as XLSX from 'xlsx';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '../../config/env';
import { refreshCatalogForTenant, type CatalogRefreshResult, type TenantCatalogTarget } from '../../lib/catalog-refresh';
import { IAuthUser } from '../../types';
import {
  daysBetweenDates,
  formatDateParts,
  formatISTDate,
  getCurrentISTDate,
  getCurrentISTMonthRange,
  getDateParts,
  shiftDate,
  startOfMonth,
  startOfQuarter,
  startOfYear
} from '../../utils/ist-date';

const copyFrom = require('pg-copy-streams').from as (sql: string) => any;

type ImportableFile = {
  filename: string;
  mimetype: string;
  toBuffer: () => Promise<Buffer>;
};

const SIGNAL_DEFINITIONS_SEED = [
  ['salesman', 'coverage', 'coverage_pct', 'LT', 'percent', '%', 'MTD', 'warning'],
  ['salesman', 'beat_adherence', 'beat_adherence_pct', 'LT', 'percent', '%', 'MTD', 'warning'],
  ['salesman', 'zero_billing_days', 'zero_billing_days', 'GT', 'days', 'days', 'ROLLING_7D', 'warning'],
  ['salesman', 'collection_ratio', 'collection_ratio_pct', 'LT', 'percent', '%', 'MTD', 'warning'],
  ['retailer', 'outstanding_level', 'outstanding_pct', 'GT', 'percent', '%', 'MTD', 'warning'],
  ['retailer', 'retailer_aov', 'aov', 'LT', 'currency', 'INR', 'MTD', 'warning'],
  ['retailer', 'days_since_last_order', 'dormancy_days', 'GT', 'days', 'days', 'ROLLING_30D', 'warning'],
  ['sku', 'sku_growth', 'growth_pct', 'LT', 'percent', '%', 'MTD', 'warning'],
  ['sku', 'sku_penetration', 'penetration_pct', 'LT', 'percent', '%', 'MTD', 'warning'],
  ['distributor', 'damage_rate', 'damage_pct', 'GT', 'percent', '%', 'MTD', 'warning'],
  ['beat', 'beat_realization', 'realization_pct', 'LT', 'percent', '%', 'MTD', 'warning']
] as const;

const SIGNAL_DEFAULT_THRESHOLDS: Array<[string, string, number]> = [
  ['salesman', 'coverage', 70],
  ['salesman', 'beat_adherence', 70],
  ['salesman', 'zero_billing_days', 3],
  ['salesman', 'collection_ratio', 85],
  ['retailer', 'outstanding_level', 150],
  ['retailer', 'retailer_aov', 5000],
  ['retailer', 'days_since_last_order', 14],
  ['sku', 'sku_growth', -5],
  ['sku', 'sku_penetration', 45],
  ['distributor', 'damage_rate', 2],
  ['beat', 'beat_realization', 75]
];

const TARGET_DEFINITIONS_SEED: Array<[string, string, string, string, string]> = [
  ['revenue', 'Revenue', 'revenue_mtd', 'currency', 'GTE'],
  ['collection', 'Collection', 'collection_mtd', 'currency', 'GTE'],
  ['coverage_pct', 'Coverage %', 'coverage_pct', 'percent', 'GTE'],
  ['beat_adherence', 'Beat Adherence %', 'beat_adherence_pct', 'percent', 'GTE'],
  ['orders', 'Orders', 'orders_mtd', 'number', 'GTE'],
  ['outstanding_reduction', 'Outstanding Reduction', 'outstanding', 'currency', 'LTE']
];

const SUPPORTED_AGGREGATE_ENTITY_TYPES_BY_TARGET_KEY: Record<string, string[]> = {
  revenue: ['salesman', 'retailer', 'beat', 'sku', 'distributor'],
  collection: ['salesman'],
  coverage_pct: ['salesman', 'beat'],
  beat_adherence: ['salesman'],
  orders: ['salesman', 'retailer', 'distributor'],
  outstanding_reduction: ['salesman', 'retailer', 'beat', 'distributor']
};

export const ORDERS_BOOK_HEADERS = [
  'S.no',
  'distributors.distributor_code',
  'distributors.distributor_name',
  'distributors.zone',
  'distributors.region',
  'distributors.area',
  'beats.beat_code',
  'beats.beat_name',
  'salesmen.salesman_code',
  'salesmen.salesman_name',
  'salesmen.employee_code',
  'salesmen.external_salesman_id',
  'salesmen.phone_number',
  'salesmen.zone',
  'salesmen.region',
  'salesmen.area',
  'outlets.external_outlet_code',
  'outlets.outlet_name',
  'outlets.mobile_number',
  'outlets.gst_number',
  'outlets.address_line1',
  'outlets.address_line2',
  'outlets.pincode',
  'outlets.latitude',
  'outlets.longitude',
  'outlets.zone',
  'outlets.region',
  'outlets.area',
  'tenant_outlets.tenant_outlet_code',
  'brands.brand_code',
  'brands.brand_name',
  'skus.sku_code',
  'skus.name',
  'skus.hsn_code',
  'skus.mrp',
  'skus.discount_amount',
  'skus.discount_percent',
  'skus.weight',
  'skus.length_cm',
  'skus.width_cm',
  'skus.height_cm',
  'skus.rate',
  'skus.sgst_percent',
  'skus.sgst_amount',
  'skus.cgst_percent',
  'skus.cgst_amount',
  'skus.amount',
  'skus.igst_percent',
  'skus.igst_amount',
  'sales_orders.external_order_id',
  'sales_orders.external_invoice_no',
  'sales_orders.external_awb_no',
  'sales_orders.order_punched_at',
  'sales_orders.order_sale_date',
  'sales_orders.gross_amount',
  'sales_orders.discount_amount',
  'sales_orders.tax_amount',
  'sales_orders.net_amount',
  'sales_orders.collections_amount',
  'sales_orders.outstanding_amount',
  'sales_orders.decided_margin_amount',
  'sales_orders.remarks',
  'sales_order_items.external_line_id',
  'sales_order_items.ordered_quantity',
  'sales_order_items.rate',
  'sales_order_items.discount_amount',
  'sales_order_items.discount_percent',
  'sales_order_items.sgst_percent',
  'sales_order_items.sgst_amount',
  'sales_order_items.cgst_percent',
  'sales_order_items.cgst_amount',
  'sales_order_items.igst_percent',
  'sales_order_items.igst_amount',
  'sales_order_items.tax_amount',
  'sales_order_items.amount',
  'order_payments.payment_date',
  'order_payments.payment_mode',
  'order_payments.amount',
  'order_payments.external_ref'
] as const;

type OrdersBookHeader = (typeof ORDERS_BOOK_HEADERS)[number];
type OrdersBookRow = Record<OrdersBookHeader, unknown>;

type ImportRowError = {
  sNo: string;
  rowNumber: number;
  column: string;
  message: string;
};

type ImportErrorPhase = 'prevalidation' | 'validation' | 'processing' | 'post_import';

type ImportBatchSummary = {
  id: number;
  tenantId: number;
  sourceFileName: string;
  sourceFileType: string | null;
  sourceSheetName: string | null;
  fileChecksum: string | null;
  fileObjectKey: string | null;
  totalRows: number;
  totalColumns: number;
  validRows: number;
  rejectedRows: number;
  errorCount: number;
  importStatus: string;
  notes: string | null;
  startedAt: string | null;
  completedAt: string | null;
  processedBy: string | null;
  refreshJobId: number | null;
  refreshStatus: string | null;
  refreshRequestedAt: string | null;
  refreshStartedAt: string | null;
  refreshCompletedAt: string | null;
  refreshError: string | null;
  importedAt: string;
  createdAt: string;
};

type NormalizedOrdersBookRow = {
  source_row_number: number;
  s_no: string;
  distributor_code: string;
  distributor_name: string;
  distributor_zone: string | null;
  distributor_region: string | null;
  distributor_area: string | null;
  beat_code: string;
  beat_name: string;
  salesman_code: string;
  salesman_name: string;
  salesman_employee_code: string | null;
  salesman_external_salesman_id: string | null;
  salesman_phone_number: string | null;
  salesman_zone: string | null;
  salesman_region: string | null;
  salesman_area: string | null;
  external_outlet_code: string | null;
  outlet_name: string | null;
  outlet_mobile_number: string | null;
  outlet_gst_number: string | null;
  outlet_address_line1: string | null;
  outlet_address_line2: string | null;
  outlet_pincode: string | null;
  outlet_latitude: number | null;
  outlet_longitude: number | null;
  outlet_zone: string | null;
  outlet_region: string | null;
  outlet_area: string | null;
  tenant_outlet_code: string;
  brand_code: string;
  brand_name: string;
  sku_code: string;
  sku_name: string;
  sku_hsn_code: string | null;
  sku_mrp: number | null;
  sku_discount_amount: number | null;
  sku_discount_percent: number | null;
  sku_weight: number | null;
  sku_length_cm: number | null;
  sku_width_cm: number | null;
  sku_height_cm: number | null;
  sku_rate: number | null;
  sku_sgst_percent: number | null;
  sku_sgst_amount: number | null;
  sku_cgst_percent: number | null;
  sku_cgst_amount: number | null;
  sku_amount: number | null;
  sku_igst_percent: number | null;
  sku_igst_amount: number | null;
  external_order_id: string | null;
  external_invoice_no: string | null;
  external_awb_no: string | null;
  order_punched_at: string | null;
  order_sale_date: string | null;
  order_gross_amount: number | null;
  order_discount_amount: number | null;
  order_tax_amount: number | null;
  order_net_amount: number | null;
  order_collections_amount: number | null;
  order_outstanding_amount: number | null;
  order_decided_margin_amount: number | null;
  order_remarks: string | null;
  external_line_id: string;
  ordered_quantity: number | null;
  line_rate: number | null;
  line_discount_amount: number | null;
  line_discount_percent: number | null;
  line_sgst_percent: number | null;
  line_sgst_amount: number | null;
  line_cgst_percent: number | null;
  line_cgst_amount: number | null;
  line_igst_percent: number | null;
  line_igst_amount: number | null;
  line_tax_amount: number | null;
  line_amount: number | null;
  payment_date: string | null;
  payment_mode: string | null;
  payment_amount: number | null;
  payment_external_ref: string | null;
  payment_identity: string | null;
};

type RefreshJobSummary = {
  id: number;
  status: string;
  requestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
};

type ImportPublishResult = {
  refreshJobId: number | null;
  signalRunId: number;
};

const IMPORT_STAGE_COLUMNS: Array<keyof NormalizedOrdersBookRow> = [
  'source_row_number',
  's_no',
  'distributor_code',
  'distributor_name',
  'distributor_zone',
  'distributor_region',
  'distributor_area',
  'beat_code',
  'beat_name',
  'salesman_code',
  'salesman_name',
  'salesman_employee_code',
  'salesman_external_salesman_id',
  'salesman_phone_number',
  'salesman_zone',
  'salesman_region',
  'salesman_area',
  'external_outlet_code',
  'outlet_name',
  'outlet_mobile_number',
  'outlet_gst_number',
  'outlet_address_line1',
  'outlet_address_line2',
  'outlet_pincode',
  'outlet_latitude',
  'outlet_longitude',
  'outlet_zone',
  'outlet_region',
  'outlet_area',
  'tenant_outlet_code',
  'brand_code',
  'brand_name',
  'sku_code',
  'sku_name',
  'sku_hsn_code',
  'sku_mrp',
  'sku_discount_amount',
  'sku_discount_percent',
  'sku_weight',
  'sku_length_cm',
  'sku_width_cm',
  'sku_height_cm',
  'sku_rate',
  'sku_sgst_percent',
  'sku_sgst_amount',
  'sku_cgst_percent',
  'sku_cgst_amount',
  'sku_amount',
  'sku_igst_percent',
  'sku_igst_amount',
  'external_order_id',
  'external_invoice_no',
  'external_awb_no',
  'order_punched_at',
  'order_sale_date',
  'order_gross_amount',
  'order_discount_amount',
  'order_tax_amount',
  'order_net_amount',
  'order_collections_amount',
  'order_outstanding_amount',
  'order_decided_margin_amount',
  'order_remarks',
  'external_line_id',
  'ordered_quantity',
  'line_rate',
  'line_discount_amount',
  'line_discount_percent',
  'line_sgst_percent',
  'line_sgst_amount',
  'line_cgst_percent',
  'line_cgst_amount',
  'line_igst_percent',
  'line_igst_amount',
  'line_tax_amount',
  'line_amount',
  'payment_date',
  'payment_mode',
  'payment_amount',
  'payment_external_ref',
  'payment_identity'
];

const IMPORT_DETAIL_ERROR_LIMIT = 100;

class ImportValidationError extends Error {
  statusCode: number;
  details: ImportRowError[];
  constructor(message: string, details: ImportRowError[]) {
    super(message);
    this.statusCode = 400;
    this.details = details;
  }
}

function toDateOnly(input: unknown): string | null {
  if (!input) {
    return null;
  }
  const value = String(input).trim();
  if (!value) {
    return null;
  }
  const directMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (directMatch) {
    return `${directMatch[1]}-${directMatch[2]}-${directMatch[3]}`;
  }

  const leadingDateMatch = value.match(/^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/);
  if (leadingDateMatch) {
    return leadingDateMatch[1];
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return formatISTDate(date);
}

function normalizePhone(value: unknown): string {
  if (!value) {
    return '';
  }
  return String(value).replace(/\D+/g, '');
}

function toNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = Number(String(value).replace(/,/g, '').trim());
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function buildRange(): { start: string; end: string } {
  return getCurrentISTMonthRange();
}

function normalizeTargetScope(scopeLevel?: string | null, scopeValue?: string | null): { scopeLevel: string; scopeValue: string } {
  const level = String(scopeLevel || 'national').trim().toLowerCase();
  const value = String(scopeValue || 'all_india').trim() || 'all_india';

  if (level === 'zone' || level === 'region' || level === 'area') {
    return {
      scopeLevel: level,
      scopeValue: value
    };
  }

  return {
    scopeLevel: 'national',
    scopeValue: 'all_india'
  };
}

function normalizeCompareTimeRange(periodLabel?: string | null): string {
  const value = String(periodLabel || 'mtd').trim().toLowerCase();
  const aliases: Record<string, string> = {
    today: 'today',
    mtd: 'mtd',
    'last 7 days': 'last7d',
    last7d: 'last7d',
    'last 30 days': 'last30d',
    last30d: 'last30d',
    'last 90 days': 'last90d',
    last90d: 'last90d'
  };

  return aliases[value] || 'mtd';
}

function normalizeTargetMetricKey(metricKey?: string | null): string {
  const value = String(metricKey || '').trim().toLowerCase();
  const aliases: Record<string, string> = {
    coverage_pct: 'coverage'
  };

  return aliases[value] || value;
}

function isAggregateTargetEntityTypeSupported(targetKey: string, entityType: string): boolean {
  return (SUPPORTED_AGGREGATE_ENTITY_TYPES_BY_TARGET_KEY[targetKey] || []).includes(entityType);
}

export class SupeV1Service {
  private readonly s3Client: S3Client;

  constructor(private readonly db: DataSource) {
    this.s3Client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials:
        env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
          ? {
              accessKeyId: env.S3_ACCESS_KEY_ID,
              secretAccessKey: env.S3_SECRET_ACCESS_KEY
            }
          : undefined
    });
  }

  private resolveTenantCode(user?: IAuthUser): string {
    if (user?.tenantId) {
      return String(user.tenantId);
    }
    throw new Error('Authenticated supe user is missing supeTenantId');
  }

  private async resolveTenantId(user?: IAuthUser): Promise<number> {
    const tenantCode = this.resolveTenantCode(user);
    const rows = await this.db.query(
      `
      insert into tenants (tenant_code, tenant_name)
      values ($1, $2)
      on conflict (tenant_code) do update set updated_at = now()
      returning id
    `,
      [tenantCode, `Tenant ${tenantCode}`]
    );
    const tenantId = Number(rows[0]?.id);
    if (!tenantId) {
      throw new Error('Unable to resolve tenant');
    }
    await this.seedStaticData(tenantId);
    return tenantId;
  }

  private async seedStaticData(tenantId: number): Promise<void> {
    for (const def of SIGNAL_DEFINITIONS_SEED) {
      await this.db.query(
        `
        insert into signal_definitions (
          entity_type, signal_key, metric_key, comparison_operator, value_type, unit_label, window_type, default_severity, active
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,true)
        on conflict (entity_type, signal_key)
        do update set
          metric_key = excluded.metric_key,
          comparison_operator = excluded.comparison_operator,
          value_type = excluded.value_type,
          unit_label = excluded.unit_label,
          window_type = excluded.window_type,
          default_severity = excluded.default_severity,
          updated_at = now()
      `,
        [...def]
      );
    }

    for (const [entityType, signalKey, threshold] of SIGNAL_DEFAULT_THRESHOLDS) {
      const signalRows = await this.db.query(
        `select id from signal_definitions where entity_type = $1 and signal_key = $2 limit 1`,
        [entityType, signalKey]
      );
      const signalDefinitionId = Number(signalRows[0]?.id);
      if (!signalDefinitionId) {
        continue;
      }
      await this.db.query(
        `
          insert into tenant_signal_thresholds (tenant_id, signal_definition_id, zone, threshold_value, is_enabled)
          values ($1, $2, 'NATIONAL', $3, true)
          on conflict (tenant_id, signal_definition_id, zone)
          do nothing
        `,
        [tenantId, signalDefinitionId, threshold]
      );
    }

    for (const [targetKey, targetName, metricKey, metricUnit, comparisonOperator] of TARGET_DEFINITIONS_SEED) {
      await this.db.query(
        `
          insert into target_definitions (tenant_id, target_key, target_name, metric_key, metric_unit, comparison_operator, active)
          values ($1, $2, $3, $4, $5, $6, true)
          on conflict (tenant_id, target_key)
          do update set
            target_name = excluded.target_name,
            metric_key = excluded.metric_key,
            metric_unit = excluded.metric_unit,
            comparison_operator = excluded.comparison_operator,
            updated_at = now()
        `,
        [tenantId, targetKey, targetName, metricKey, metricUnit, comparisonOperator]
      );
    }
  }

  private async resolveTenantCatalogTarget(tenantId: number): Promise<TenantCatalogTarget> {
    const rows = await this.db.query(`select id, tenant_code from tenants where id = $1 limit 1`, [tenantId]);
    if (!rows.length) {
      throw new Error(`Tenant ${tenantId} not found`);
    }
    return {
      id: Number(rows[0].id),
      tenantCode: String(rows[0].tenant_code)
    };
  }

  protected async refreshCatalogState(tenant: TenantCatalogTarget, triggeredBy: string): Promise<CatalogRefreshResult> {
    return refreshCatalogForTenant(this.db, tenant, triggeredBy);
  }

  private async uploadToS3(tenantCode: string, fileName: string, buffer: Buffer, contentType: string): Promise<string> {
    if (!env.S3_BUCKET) {
      throw new Error('S3_BUCKET is required for imports');
    }

    const key = `imports/${tenantCode}/${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]+/g, '_')}`;
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType || 'application/octet-stream'
      })
    );
    return key;
  }

  private async findOrCreateByName(
    runner: QueryRunner,
    tableName: 'brands' | 'sku_categories',
    nameColumn: 'brand_name' | 'category_name',
    codeColumn: 'brand_code' | 'category_code',
    name: string,
    code?: string
  ): Promise<number | null> {
    if (!name) {
      return null;
    }
    const existing = await runner.query(`select id from ${tableName} where lower(${nameColumn}) = lower($1) limit 1`, [name]);
    if (existing.length) {
      return Number(existing[0].id);
    }
    const created = await runner.query(
      `insert into ${tableName} (${nameColumn}, ${codeColumn}, active) values ($1, $2, true) returning id`,
      [name, code || null]
    );
    return Number(created[0].id);
  }

  private async upsertDistributor(
    runner: QueryRunner,
    tenantId: number,
    payload: { code: string; name: string; zone: string; region: string; area: string }
  ): Promise<number | null> {
    if (!payload.code && !payload.name) {
      return null;
    }
    let existing: any[] = [];
    if (payload.code) {
      existing = await runner.query(`select id from distributors where tenant_id = $1 and distributor_code = $2 limit 1`, [
        tenantId,
        payload.code
      ]);
    }
    if (!existing.length && payload.name) {
      existing = await runner.query(
        `select id from distributors where tenant_id = $1 and lower(distributor_name) = lower($2) limit 1`,
        [tenantId, payload.name]
      );
    }
    if (existing.length) {
      const id = Number(existing[0].id);
      await runner.query(
        `
          update distributors
          set distributor_code = coalesce($2, distributor_code),
              distributor_name = coalesce($3, distributor_name),
              zone = coalesce($4, zone),
              region = coalesce($5, region),
              area = coalesce($6, area),
              updated_at = now()
          where id = $1
        `,
        [id, payload.code || null, payload.name || null, payload.zone || null, payload.region || null, payload.area || null]
      );
      return id;
    }
    const created = await runner.query(
      `
        insert into distributors (tenant_id, distributor_code, distributor_name, zone, region, area, active)
        values ($1,$2,$3,$4,$5,$6,true)
        returning id
      `,
      [tenantId, payload.code || null, payload.name || payload.code, payload.zone || null, payload.region || null, payload.area || null]
    );
    return Number(created[0].id);
  }

  private async upsertBeat(
    runner: QueryRunner,
    tenantId: number,
    payload: { code: string; name: string; zone: string; region: string; area: string; distributorId: number | null }
  ): Promise<number | null> {
    if (!payload.code && !payload.name) {
      return null;
    }
    let existing: any[] = [];
    if (payload.code) {
      existing = await runner.query(`select id from beats where tenant_id = $1 and beat_code = $2 limit 1`, [tenantId, payload.code]);
    }
    if (!existing.length && payload.name) {
      existing = await runner.query(`select id from beats where tenant_id = $1 and lower(beat_name) = lower($2) limit 1`, [
        tenantId,
        payload.name
      ]);
    }
    if (existing.length) {
      const id = Number(existing[0].id);
      await runner.query(
        `
          update beats
          set beat_code = coalesce($2, beat_code),
              beat_name = coalesce($3, beat_name),
              zone = coalesce($4, zone),
              region = coalesce($5, region),
              area = coalesce($6, area),
              distributor_id = coalesce($7, distributor_id),
              updated_at = now()
          where id = $1
        `,
        [id, payload.code || null, payload.name || null, payload.zone || null, payload.region || null, payload.area || null, payload.distributorId]
      );
      return id;
    }
    const created = await runner.query(
      `
        insert into beats (tenant_id, beat_code, beat_name, zone, region, area, distributor_id, active)
        values ($1,$2,$3,$4,$5,$6,$7,true)
        returning id
      `,
      [
        tenantId,
        payload.code || null,
        payload.name || payload.code,
        payload.zone || null,
        payload.region || null,
        payload.area || null,
        payload.distributorId
      ]
    );
    return Number(created[0].id);
  }

  private async upsertSalesman(
    runner: QueryRunner,
    tenantId: number,
    payload: {
      externalSalesmanId: string;
      employeeCode: string;
      name: string;
      phoneNumber: string;
      zone: string;
      region: string;
      area: string;
      distributorId: number | null;
    }
  ): Promise<number | null> {
    if (!payload.externalSalesmanId && !payload.employeeCode && !payload.phoneNumber && !payload.name) {
      return null;
    }
    const phone = normalizePhone(payload.phoneNumber);
    let existing: any[] = [];
    if (payload.employeeCode) {
      existing = await runner.query(`select id from salesmen where tenant_id = $1 and employee_code = $2 limit 1`, [
        tenantId,
        payload.employeeCode
      ]);
    }
    if (!existing.length && payload.externalSalesmanId) {
      existing = await runner.query(
        `select id from salesmen where tenant_id = $1 and external_salesman_id = $2 limit 1`,
        [tenantId, payload.externalSalesmanId]
      );
    }
    if (!existing.length && phone) {
      existing = await runner.query(
        `select id from salesmen where tenant_id = $1 and regexp_replace(coalesce(phone_number,''), '\\D+', '', 'g') = $2 limit 1`,
        [tenantId, phone]
      );
    }
    if (existing.length) {
      const id = Number(existing[0].id);
      await runner.query(
        `
          update salesmen
          set external_salesman_id = coalesce($2, external_salesman_id),
              employee_code = coalesce($3, employee_code),
              salesman_name = coalesce($4, salesman_name),
              phone_number = coalesce($5, phone_number),
              zone = coalesce($6, zone),
              region = coalesce($7, region),
              area = coalesce($8, area),
              distributor_id = coalesce($9, distributor_id),
              updated_at = now()
          where id = $1
        `,
        [
          id,
          payload.externalSalesmanId || null,
          payload.employeeCode || null,
          payload.name || null,
          phone || null,
          payload.zone || null,
          payload.region || null,
          payload.area || null,
          payload.distributorId
        ]
      );
      return id;
    }
    const created = await runner.query(
      `
      insert into salesmen (
        tenant_id, external_salesman_id, employee_code, salesman_name, phone_number, zone, region, area, distributor_id, active
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
      returning id
    `,
      [
        tenantId,
        payload.externalSalesmanId || null,
        payload.employeeCode || null,
        payload.name || payload.employeeCode || payload.externalSalesmanId || phone,
        phone || null,
        payload.zone || null,
        payload.region || null,
        payload.area || null,
        payload.distributorId
      ]
    );
    return Number(created[0].id);
  }

  private async upsertOutletWithTenant(
    runner: QueryRunner,
    tenantId: number,
    payload: {
      tenantOutletCode: string;
      externalOutletCode: string;
      outletName: string;
      mobileNumber: string;
      zone: string;
      region: string;
      area: string;
      addressLine1: string;
      addressLine2: string;
      pincode: string;
      gstNumber: string;
      beatId: number | null;
      salesmanId: number | null;
      distributorId: number | null;
      orderDate: string | null;
    }
  ): Promise<{ outletId: number; tenantOutletId: number }> {
    const mobile = normalizePhone(payload.mobileNumber);
    let outletId: number | null = null;

    if (payload.tenantOutletCode) {
      const byTenantCode = await runner.query(
        `
          select o.id
          from tenant_outlets t
          join outlets o on o.id = t.outlet_id
          where t.tenant_id = $1 and t.tenant_outlet_code = $2
          limit 1
        `,
        [tenantId, payload.tenantOutletCode]
      );
      if (byTenantCode.length) {
        outletId = Number(byTenantCode[0].id);
      }
    }

    if (!outletId && payload.externalOutletCode) {
      const byExternal = await runner.query(`select id from outlets where external_outlet_code = $1 limit 1`, [
        payload.externalOutletCode
      ]);
      if (byExternal.length) {
        outletId = Number(byExternal[0].id);
      }
    }

    if (!outletId && mobile) {
      const byMobile = await runner.query(
        `select id from outlets where regexp_replace(coalesce(mobile_number,''), '\\D+', '', 'g') = $1 limit 1`,
        [mobile]
      );
      if (byMobile.length) {
        outletId = Number(byMobile[0].id);
      }
    }

    if (!outletId) {
      const created = await runner.query(
        `
          insert into outlets (
            external_outlet_code, outlet_name, mobile_number, address_line1, address_line2, pincode, gst_number,
            zone, region, area, active
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
          returning id
        `,
        [
          payload.externalOutletCode || null,
          payload.outletName || payload.externalOutletCode || payload.tenantOutletCode || mobile || 'Unknown Outlet',
          mobile || null,
          payload.addressLine1 || null,
          payload.addressLine2 || null,
          payload.pincode || null,
          payload.gstNumber || null,
          payload.zone || null,
          payload.region || null,
          payload.area || null
        ]
      );
      outletId = Number(created[0].id);
    } else {
      await runner.query(
        `
          update outlets
          set external_outlet_code = coalesce($2, external_outlet_code),
              outlet_name = coalesce($3, outlet_name),
              mobile_number = coalesce($4, mobile_number),
              address_line1 = coalesce($5, address_line1),
              address_line2 = coalesce($6, address_line2),
              pincode = coalesce($7, pincode),
              gst_number = coalesce($8, gst_number),
              zone = coalesce($9, zone),
              region = coalesce($10, region),
              area = coalesce($11, area),
              updated_at = now()
          where id = $1
        `,
        [
          outletId,
          payload.externalOutletCode || null,
          payload.outletName || null,
          mobile || null,
          payload.addressLine1 || null,
          payload.addressLine2 || null,
          payload.pincode || null,
          payload.gstNumber || null,
          payload.zone || null,
          payload.region || null,
          payload.area || null
        ]
      );
    }

    let tenantOutlet = await runner.query(`select id from tenant_outlets where tenant_id = $1 and outlet_id = $2 limit 1`, [
      tenantId,
      outletId
    ]);

    if (!tenantOutlet.length && payload.tenantOutletCode) {
      tenantOutlet = await runner.query(
        `select id from tenant_outlets where tenant_id = $1 and tenant_outlet_code = $2 limit 1`,
        [tenantId, payload.tenantOutletCode]
      );
    }

    let tenantOutletId: number;
    if (tenantOutlet.length) {
      tenantOutletId = Number(tenantOutlet[0].id);
      await runner.query(
        `
          update tenant_outlets
          set outlet_id = $2,
              beat_id = coalesce($3, beat_id),
              salesman_id = coalesce($4, salesman_id),
              distributor_id = coalesce($5, distributor_id),
              tenant_outlet_code = coalesce($6, tenant_outlet_code),
              first_order_date = coalesce(first_order_date, $7::date),
              last_order_date = coalesce($7::date, last_order_date),
              updated_at = now()
          where id = $1
        `,
        [
          tenantOutletId,
          outletId,
          payload.beatId,
          payload.salesmanId,
          payload.distributorId,
          payload.tenantOutletCode || null,
          payload.orderDate
        ]
      );
    } else {
      const createdTenantOutlet = await runner.query(
        `
          insert into tenant_outlets (
            tenant_id, outlet_id, beat_id, salesman_id, distributor_id, tenant_outlet_code, servicing_status,
            active, first_order_date, last_order_date
          )
          values ($1,$2,$3,$4,$5,$6,'active',true,$7::date,$7::date)
          returning id
        `,
        [tenantId, outletId, payload.beatId, payload.salesmanId, payload.distributorId, payload.tenantOutletCode || null, payload.orderDate]
      );
      tenantOutletId = Number(createdTenantOutlet[0].id);
    }

    return { outletId, tenantOutletId };
  }

  private async upsertSku(
    runner: QueryRunner,
    payload: {
      skuCode: string;
      externalSkuId: string;
      skuName: string;
      packSize: string;
      unitOfMeasure: string;
      mrp: number | null;
      gstPercent: number | null;
      zone: string;
      region: string;
      area: string;
      brandId: number | null;
      categoryId: number | null;
    }
  ): Promise<number | null> {
    if (!payload.skuCode && !payload.externalSkuId && !payload.skuName) {
      return null;
    }

    let existing: any[] = [];
    if (payload.skuCode) {
      existing = await runner.query(`select id from skus where sku_code = $1 limit 1`, [payload.skuCode]);
    }
    if (!existing.length && payload.externalSkuId) {
      existing = await runner.query(`select id from skus where external_sku_id = $1 limit 1`, [payload.externalSkuId]);
    }
    if (!existing.length && payload.skuName) {
      existing = await runner.query(
        `
          select id from skus
          where lower(sku_name) = lower($1)
            and coalesce(lower(pack_size), '') = coalesce(lower($2), '')
          limit 1
        `,
        [payload.skuName, payload.packSize || '']
      );
    }

    if (existing.length) {
      const skuId = Number(existing[0].id);
      await runner.query(
        `
          update skus
          set brand_id = coalesce($2, brand_id),
              category_id = coalesce($3, category_id),
              external_sku_id = coalesce($4, external_sku_id),
              sku_code = coalesce($5, sku_code),
              sku_name = coalesce($6, sku_name),
              pack_size = coalesce($7, pack_size),
              unit_of_measure = coalesce($8, unit_of_measure),
              mrp = coalesce($9, mrp),
              gst_percent = coalesce($10, gst_percent),
              zone = coalesce($11, zone),
              region = coalesce($12, region),
              area = coalesce($13, area),
              updated_at = now()
          where id = $1
        `,
        [
          skuId,
          payload.brandId,
          payload.categoryId,
          payload.externalSkuId || null,
          payload.skuCode || null,
          payload.skuName || null,
          payload.packSize || null,
          payload.unitOfMeasure || null,
          payload.mrp,
          payload.gstPercent,
          payload.zone || null,
          payload.region || null,
          payload.area || null
        ]
      );
      return skuId;
    }

    const created = await runner.query(
      `
        insert into skus (
          brand_id, category_id, external_sku_id, sku_code, sku_name, pack_size, unit_of_measure, mrp, gst_percent, zone, region, area, active
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)
        returning id
      `,
      [
        payload.brandId,
        payload.categoryId,
        payload.externalSkuId || null,
        payload.skuCode || null,
        payload.skuName || payload.skuCode || payload.externalSkuId,
        payload.packSize || null,
        payload.unitOfMeasure || null,
        payload.mrp,
        payload.gstPercent,
        payload.zone || null,
        payload.region || null,
        payload.area || null
      ]
    );
    return Number(created[0].id);
  }

  private async upsertSalesOrder(
    runner: QueryRunner,
    payload: {
      tenantId: number;
      dataSourceId: number;
      importBatchId: number;
      externalOrderId: string;
      externalInvoiceNo: string;
      externalAwbNo: string;
      orderDate: string | null;
      orderPunchedAt: string | null;
      outletId: number;
      tenantOutletId: number;
      beatId: number | null;
      salesmanId: number | null;
      distributorId: number | null;
      grossAmount: number | null;
      discountAmount: number | null;
      taxAmount: number | null;
      netAmount: number | null;
      collectionsAmount: number | null;
      outstandingAmount: number | null;
      marginAmount: number | null;
      remarks: string;
      rawRecordId: number;
    }
  ): Promise<number> {
    let resolvedOrderId = payload.externalOrderId;
    if (!payload.externalInvoiceNo && !payload.externalAwbNo && !resolvedOrderId) {
      resolvedOrderId = `HASH:${createHash('sha1')
        .update(
          `${payload.tenantId}|${payload.orderDate || ''}|${payload.outletId}|${payload.netAmount || 0}|${payload.grossAmount || 0}`
        )
        .digest('hex')}`;
    }

    let existing: any[] = [];
    if (payload.externalInvoiceNo) {
      existing = await runner.query(
        `select id from sales_orders where tenant_id = $1 and external_invoice_no = $2 limit 1`,
        [payload.tenantId, payload.externalInvoiceNo]
      );
    }
    if (!existing.length && payload.externalAwbNo) {
      existing = await runner.query(`select id from sales_orders where tenant_id = $1 and external_awb_no = $2 limit 1`, [
        payload.tenantId,
        payload.externalAwbNo
      ]);
    }
    if (!existing.length && resolvedOrderId) {
      existing = await runner.query(`select id from sales_orders where tenant_id = $1 and external_order_id = $2 limit 1`, [
        payload.tenantId,
        resolvedOrderId
      ]);
    }

    if (existing.length) {
      const orderId = Number(existing[0].id);
      await runner.query(
        `
          update sales_orders
          set data_source_id = $2,
              import_batch_id = $3,
              external_order_id = coalesce($4, external_order_id),
              external_invoice_no = coalesce($5, external_invoice_no),
              external_awb_no = coalesce($6, external_awb_no),
              order_punched_at = coalesce($7::timestamptz, order_punched_at),
              order_sale_date = coalesce($8::date, order_sale_date),
              outlet_id = $9,
              tenant_outlet_id = $10,
              beat_id = coalesce($11, beat_id),
              salesman_id = coalesce($12, salesman_id),
              distributor_id = coalesce($13, distributor_id),
              gross_amount = coalesce($14, gross_amount),
              discount_amount = coalesce($15, discount_amount),
              tax_amount = coalesce($16, tax_amount),
              net_amount = coalesce($17, net_amount),
              collections_amount = coalesce($18, collections_amount),
              outstanding_amount = coalesce($19, outstanding_amount),
              decided_margin_amount = coalesce($20, decided_margin_amount),
              remarks = coalesce($21, remarks),
              latest_source_record_id = $22,
              updated_at = now()
          where id = $1
        `,
        [
          orderId,
          payload.dataSourceId,
          payload.importBatchId,
          resolvedOrderId || null,
          payload.externalInvoiceNo || null,
          payload.externalAwbNo || null,
          payload.orderPunchedAt,
          payload.orderDate,
          payload.outletId,
          payload.tenantOutletId,
          payload.beatId,
          payload.salesmanId,
          payload.distributorId,
          payload.grossAmount,
          payload.discountAmount,
          payload.taxAmount,
          payload.netAmount,
          payload.collectionsAmount,
          payload.outstandingAmount,
          payload.marginAmount,
          payload.remarks || null,
          payload.rawRecordId
        ]
      );
      return orderId;
    }

    const created = await runner.query(
      `
        insert into sales_orders (
          tenant_id, data_source_id, import_batch_id, external_order_id, external_invoice_no, external_awb_no,
          order_punched_at, order_sale_date, outlet_id, tenant_outlet_id, beat_id, salesman_id, distributor_id,
          gross_amount, discount_amount, tax_amount, net_amount, collections_amount, outstanding_amount, decided_margin_amount,
          remarks, first_source_record_id, latest_source_record_id
        )
        values ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::date,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$22)
        returning id
      `,
      [
        payload.tenantId,
        payload.dataSourceId,
        payload.importBatchId,
        resolvedOrderId || null,
        payload.externalInvoiceNo || null,
        payload.externalAwbNo || null,
        payload.orderPunchedAt,
        payload.orderDate,
        payload.outletId,
        payload.tenantOutletId,
        payload.beatId,
        payload.salesmanId,
        payload.distributorId,
        payload.grossAmount,
        payload.discountAmount,
        payload.taxAmount,
        payload.netAmount,
        payload.collectionsAmount,
        payload.outstandingAmount,
        payload.marginAmount,
        payload.remarks || null,
        payload.rawRecordId
      ]
    );
    return Number(created[0].id);
  }

  private async upsertSalesOrderItem(
    runner: QueryRunner,
    payload: {
      salesOrderId: number;
      skuId: number;
      externalLineId: string;
      orderedQuantity: number;
      unitPrice: number | null;
      grossAmount: number | null;
      discountAmount: number | null;
      taxAmount: number | null;
      netAmount: number | null;
      marginPercent: number | null;
      marginAmount: number | null;
      rawRecordId: number;
    }
  ): Promise<number> {
    const existing = await runner.query(
      `select id from sales_order_items where sales_order_id = $1 and external_line_id = $2 limit 1`,
      [payload.salesOrderId, payload.externalLineId]
    );
    if (existing.length) {
      const itemId = Number(existing[0].id);
      await runner.query(
        `
          update sales_order_items
          set sku_id = $2,
              ordered_quantity = $3,
              unit_price = $4,
              gross_amount = $5,
              discount_amount = $6,
              tax_amount = $7,
              net_amount = $8,
              margin_percent = $9,
              margin_amount = $10,
              latest_source_record_id = $11
          where id = $1
        `,
        [
          itemId,
          payload.skuId,
          payload.orderedQuantity,
          payload.unitPrice,
          payload.grossAmount,
          payload.discountAmount,
          payload.taxAmount,
          payload.netAmount,
          payload.marginPercent,
          payload.marginAmount,
          payload.rawRecordId
        ]
      );
      return itemId;
    }

    const created = await runner.query(
      `
        insert into sales_order_items (
          sales_order_id, sku_id, external_line_id, ordered_quantity, unit_price, gross_amount, discount_amount, tax_amount, net_amount,
          margin_percent, margin_amount, first_source_record_id, latest_source_record_id
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
        returning id
      `,
      [
        payload.salesOrderId,
        payload.skuId,
        payload.externalLineId,
        payload.orderedQuantity,
        payload.unitPrice,
        payload.grossAmount,
        payload.discountAmount,
        payload.taxAmount,
        payload.netAmount,
        payload.marginPercent,
        payload.marginAmount,
        payload.rawRecordId
      ]
    );
    return Number(created[0].id);
  }

  private async insertCanonicalLineage(
    runner: QueryRunner,
    entityName: string,
    entityPk: number,
    rawRecordId: number,
    role: string
  ): Promise<void> {
    await runner.query(
      `
      insert into canonical_record_sources (entity_name, entity_pk, raw_record_id, role)
      values ($1, $2, $3, $4)
    `,
      [entityName, entityPk, rawRecordId, role]
    );
  }

  private async insertSnapshotMetric(
    runner: QueryRunner,
    payload: {
      tenantId: number;
      entityType: string;
      entityId: string;
      entityName: string;
      metricKey: string;
      metricValue: number;
      metricUnit: string;
      snapshotDate: string;
      periodStart: string;
      periodEnd: string;
      zone?: string | null;
      region?: string | null;
      area?: string | null;
    }
  ): Promise<void> {
    await runner.query(
      `
        insert into entity_metric_snapshots (
          tenant_id, entity_type, entity_id, entity_name, metric_key, metric_label, metric_unit, time_granularity,
          snapshot_date, period_start_date, period_end_date, zone, region, area, metric_value
        )
        values ($1,$2,$3,$4,$5,$5,$6,'month',$7::date,$8::date,$9::date,$10,$11,$12,$13)
      `,
      [
        payload.tenantId,
        payload.entityType,
        payload.entityId,
        payload.entityName,
        payload.metricKey,
        payload.metricUnit,
        payload.snapshotDate,
        payload.periodStart,
        payload.periodEnd,
        payload.zone || null,
        payload.region || null,
        payload.area || null,
        Number(payload.metricValue || 0)
      ]
    );
  }

  private async refreshSnapshots(runner: QueryRunner, tenantId: number): Promise<void> {
    const range = buildRange();
    await runner.query(`delete from entity_metric_snapshots where tenant_id = $1 and snapshot_date = $2::date`, [
      tenantId,
      range.end
    ]);

    const summary = await runner.query(
      `
        select
          coalesce(sum(so.net_amount), 0) as gmv,
          coalesce(sum(so.collections_amount), 0) as collections,
          count(distinct so.id) as orders,
          count(distinct so.outlet_id) as billed_outlets,
          (
            select count(*) from tenant_outlets to2
            where to2.tenant_id = $1 and to2.active = true
          ) as total_outlets
        from sales_orders so
        where so.tenant_id = $1
          and so.order_sale_date between $2::date and $3::date
      `,
      [tenantId, range.start, range.end]
    );
    const summaryRow = summary[0] || {};
    const coveragePct =
      Number(summaryRow.total_outlets || 0) > 0
        ? (Number(summaryRow.billed_outlets || 0) * 100) / Number(summaryRow.total_outlets || 1)
        : 0;
    const summaryMetrics: Array<[string, number, string]> = [
      ['gmv', Number(summaryRow.gmv || 0), 'currency'],
      ['collections', Number(summaryRow.collections || 0), 'currency'],
      ['orders', Number(summaryRow.orders || 0), 'number'],
      ['coverage_pct', coveragePct, 'percent']
    ];
    for (const [metricKey, value, unit] of summaryMetrics) {
      await this.insertSnapshotMetric(runner, {
        tenantId,
        entityType: 'summary',
        entityId: 'summary',
        entityName: 'Summary',
        metricKey,
        metricValue: value,
        metricUnit: unit,
        snapshotDate: range.end,
        periodStart: range.start,
        periodEnd: range.end
      });
    }

    const salesmanRows = await runner.query(
      `
      with order_metrics as (
        select
          salesman_id,
          coalesce(sum(net_amount), 0) as revenue_mtd,
          coalesce(sum(collections_amount), 0) as collection_mtd,
          count(distinct id) as orders_mtd,
          count(distinct outlet_id) as billed_outlets,
          coalesce(sum(outstanding_amount), 0) as mtd_outstanding
        from sales_orders
        where tenant_id = $1
          and order_sale_date between $2::date and $3::date
          and salesman_id is not null
        group by salesman_id
      ),
      outlet_metrics as (
        select
          salesman_id,
          count(distinct outlet_id) as assigned_outlets
        from tenant_outlets
        where tenant_id = $1
          and active = true
          and salesman_id is not null
        group by salesman_id
      )
      select
        s.id::text as entity_id,
        s.salesman_name as entity_name,
        s.zone, s.region, s.area,
        coalesce(om.revenue_mtd, 0) as revenue_mtd,
        coalesce(om.collection_mtd, 0) as collection_mtd,
        coalesce(om.orders_mtd, 0) as orders_mtd,
        coalesce(om.billed_outlets, 0) as billed_outlets,
        coalesce(otm.assigned_outlets, 0) as assigned_outlets,
        coalesce(om.mtd_outstanding, 0) as mtd_outstanding,
        coalesce((
          select sum(so_all.outstanding_amount)
          from sales_orders so_all
          where so_all.tenant_id = $1
            and so_all.salesman_id = s.id
        ), 0) as total_outstanding
      from salesmen s
      left join order_metrics om on om.salesman_id = s.id
      left join outlet_metrics otm on otm.salesman_id = s.id
      where s.tenant_id = $1 and s.active = true
      `,
      [tenantId, range.start, range.end]
    );
    for (const row of salesmanRows) {
      const assigned = Number(row.assigned_outlets || 0);
      const billed = Number(row.billed_outlets || 0);
      const coverage = assigned > 0 ? (billed * 100) / assigned : 0;
      for (const [metricKey, metricValue, unit] of [
        ['revenue_mtd', Number(row.revenue_mtd || 0), 'currency'],
        ['collection_mtd', Number(row.collection_mtd || 0), 'currency'],
        ['orders_mtd', Number(row.orders_mtd || 0), 'number'],
        ['coverage_pct', coverage, 'percent'],
        ['beat_adherence_pct', coverage, 'percent'],
        ['outstanding', Number(row.total_outstanding || 0), 'currency'],
        ['mtd_outstanding', Number(row.mtd_outstanding || 0), 'currency']
      ] as Array<[string, number, string]>) {
        await this.insertSnapshotMetric(runner, {
          tenantId,
          entityType: 'salesman',
          entityId: row.entity_id,
          entityName: row.entity_name,
          metricKey,
          metricValue,
          metricUnit: unit,
          snapshotDate: range.end,
          periodStart: range.start,
          periodEnd: range.end,
          zone: row.zone,
          region: row.region,
          area: row.area
        });
      }
    }

    const retailerRows = await runner.query(
      `
      with retailer_outstanding as (
        select
          tenant_outlet_id,
          coalesce(sum(outstanding_amount), 0) as total_outstanding
        from sales_orders
        where tenant_id = $1
          and tenant_outlet_id is not null
        group by tenant_outlet_id
      ),
      retailer_history as (
        select
          tenant_outlet_id,
          max(order_sale_date) as last_order_date
        from sales_orders
        where tenant_id = $1
          and tenant_outlet_id is not null
        group by tenant_outlet_id
      )
      select
        o.id::text as entity_id,
        o.outlet_name as entity_name,
        o.zone, o.region, o.area,
        coalesce(sum(so.net_amount), 0) as revenue_mtd,
        count(distinct so.id) as orders_mtd,
        coalesce(sum(so.outstanding_amount), 0) as mtd_outstanding,
        coalesce(max(ro.total_outstanding), 0) as total_outstanding,
        max(rh.last_order_date) as last_order_date
      from tenant_outlets to2
      join outlets o on o.id = to2.outlet_id
      left join sales_orders so
        on so.tenant_outlet_id = to2.id
        and so.tenant_id = $1
        and so.order_sale_date between $2::date and $3::date
      left join retailer_outstanding ro on ro.tenant_outlet_id = to2.id
      left join retailer_history rh on rh.tenant_outlet_id = to2.id
      where to2.tenant_id = $1 and to2.active = true
      group by to2.id, o.id, o.outlet_name, o.zone, o.region, o.area
      `,
      [tenantId, range.start, range.end]
    );
    const today = getCurrentISTDate();
    for (const row of retailerRows) {
      const orders = Number(row.orders_mtd || 0);
      const revenue = Number(row.revenue_mtd || 0);
      const lastOrderDate = toDateOnly(row.last_order_date);
      const dormancyDays = lastOrderDate ? daysBetweenDates(lastOrderDate, today) : 999;
      for (const [metricKey, metricValue, unit] of [
        ['revenue_mtd', revenue, 'currency'],
        ['aov', orders > 0 ? revenue / orders : 0, 'currency'],
        ['orders_mtd', orders, 'number'],
        ['outstanding', Number(row.total_outstanding || 0), 'currency'],
        ['mtd_outstanding', Number(row.mtd_outstanding || 0), 'currency'],
        ['dormancy_days', dormancyDays, 'days']
      ] as Array<[string, number, string]>) {
        await this.insertSnapshotMetric(runner, {
          tenantId,
          entityType: 'retailer',
          entityId: row.entity_id,
          entityName: row.entity_name,
          metricKey,
          metricValue,
          metricUnit: unit,
          snapshotDate: range.end,
          periodStart: range.start,
          periodEnd: range.end,
          zone: row.zone,
          region: row.region,
          area: row.area
        });
      }
    }

    const beatRows = await runner.query(
      `
      with order_metrics as (
        select
          beat_id,
          coalesce(sum(net_amount), 0) as revenue_mtd,
          count(distinct id) as visits_mtd,
          count(distinct outlet_id) as active_outlets,
          coalesce(sum(outstanding_amount), 0) as mtd_outstanding
        from sales_orders
        where tenant_id = $1
          and order_sale_date between $2::date and $3::date
          and beat_id is not null
        group by beat_id
      ),
      outlet_metrics as (
        select
          beat_id,
          count(distinct outlet_id) as total_outlets
        from beat_outlets
        where tenant_id = $1
          and active = true
          and beat_id is not null
        group by beat_id
      )
      select
        b.id::text as entity_id,
        b.beat_name as entity_name,
        b.zone, b.region, b.area,
        coalesce(om.revenue_mtd, 0) as revenue_mtd,
        coalesce(om.visits_mtd, 0) as visits_mtd,
        coalesce(om.active_outlets, 0) as active_outlets,
        coalesce(otm.total_outlets, 0) as total_outlets,
        coalesce(om.mtd_outstanding, 0) as mtd_outstanding,
        coalesce((
          select sum(so_all.outstanding_amount)
          from sales_orders so_all
          where so_all.tenant_id = $1
            and so_all.beat_id = b.id
        ), 0) as total_outstanding
      from beats b
      left join order_metrics om on om.beat_id = b.id
      left join outlet_metrics otm on otm.beat_id = b.id
      where b.tenant_id = $1 and b.active = true
      `,
      [tenantId, range.start, range.end]
    );
    for (const row of beatRows) {
      const total = Number(row.total_outlets || 0);
      const active = Number(row.active_outlets || 0);
      const coverage = total > 0 ? (active * 100) / total : 0;
      const visits = Number(row.visits_mtd || 0);
      const revenue = Number(row.revenue_mtd || 0);
      const ebv = total * 2500;
      const realization = ebv > 0 ? (revenue * 100) / ebv : 0;
      for (const [metricKey, metricValue, unit] of [
        ['revenue_mtd', revenue, 'currency'],
        ['ebv', ebv, 'currency'],
        ['total_retailers', total, 'number'],
        ['visits_mtd', visits, 'number'],
        ['coverage_pct', coverage, 'percent'],
        ['realization_pct', realization, 'percent'],
        ['outstanding', Number(row.total_outstanding || 0), 'currency'],
        ['mtd_outstanding', Number(row.mtd_outstanding || 0), 'currency']
      ] as Array<[string, number, string]>) {
        await this.insertSnapshotMetric(runner, {
          tenantId,
          entityType: 'beat',
          entityId: row.entity_id,
          entityName: row.entity_name,
          metricKey,
          metricValue,
          metricUnit: unit,
          snapshotDate: range.end,
          periodStart: range.start,
          periodEnd: range.end,
          zone: row.zone,
          region: row.region,
          area: row.area
        });
      }
    }

    const skuRows = await runner.query(
      `
      with previous_period as (
        select
          $4::date as period_start,
          $5::date as period_end
      )
      select
        s.id::text as entity_id,
        s.name as entity_name,
        max(o.zone) as zone,
        max(o.region) as region,
        max(o.area) as area,
        coalesce(sum(soi.amount), 0) as revenue_mtd,
        coalesce(sum(soi.ordered_quantity), 0) as units_mtd,
        count(distinct so.outlet_id) as outlets_mtd,
        coalesce((
          select sum(soi_prev.amount)
          from sales_order_items soi_prev
          join sales_orders so_prev on so_prev.id = soi_prev.sales_order_id
          join previous_period pp on true
          where soi_prev.sku_id = s.id
            and so_prev.tenant_id = $1
            and so_prev.order_sale_date between pp.period_start and pp.period_end
        ), 0) as revenue_prev
      from skus s
      left join sales_order_items soi on soi.sku_id = s.id
      left join sales_orders so
        on so.id = soi.sales_order_id and so.tenant_id = $1 and so.order_sale_date between $2::date and $3::date
      left join outlets o on o.id = so.outlet_id
      where s.tenant_id = $1 and s.active = true
      group by s.id, s.name
      `,
      [
        tenantId,
        range.start,
        range.end,
        startOfMonth(this.previousComparableMonthDate(range.end)),
        this.previousComparableMonthDate(range.end)
      ]
    );
    const outletCountRows = await runner.query(`select count(*)::int as total from tenant_outlets where tenant_id = $1 and active = true`, [
      tenantId
    ]);
    const totalOutlets = Number(outletCountRows[0]?.total || 0);
    for (const row of skuRows) {
      const outlets = Number(row.outlets_mtd || 0);
      const revenue = Number(row.revenue_mtd || 0);
      const previousRevenue = Number(row.revenue_prev || 0);
      const growthPct = previousRevenue > 0 ? ((revenue - previousRevenue) * 100) / previousRevenue : revenue > 0 ? 100 : 0;
      for (const [metricKey, metricValue, unit] of [
        ['revenue_mtd', revenue, 'currency'],
        ['units_mtd', Number(row.units_mtd || 0), 'number'],
        ['outlets_mtd', outlets, 'number'],
        ['penetration_pct', totalOutlets > 0 ? (outlets * 100) / totalOutlets : 0, 'percent'],
        ['growth_pct', growthPct, 'percent']
      ] as Array<[string, number, string]>) {
        await this.insertSnapshotMetric(runner, {
          tenantId,
          entityType: 'sku',
          entityId: row.entity_id,
          entityName: row.entity_name,
          metricKey,
          metricValue,
          metricUnit: unit,
          snapshotDate: range.end,
          periodStart: range.start,
          periodEnd: range.end,
          zone: row.zone,
          region: row.region,
          area: row.area
        });
      }
    }

    const distributorRows = await runner.query(
      `
      select
        d.id::text as entity_id,
        d.distributor_name as entity_name,
        d.zone, d.region, d.area,
        coalesce(sum(so.net_amount), 0) as revenue_mtd,
        count(distinct so.id) as orders_mtd,
        coalesce(sum(so.outstanding_amount), 0) as mtd_outstanding,
        coalesce((
          select sum(so_all.outstanding_amount)
          from sales_orders so_all
          where so_all.tenant_id = $1
            and so_all.distributor_id = d.id
        ), 0) as total_outstanding
      from distributors d
      left join sales_orders so
        on so.distributor_id = d.id and so.tenant_id = $1 and so.order_sale_date between $2::date and $3::date
      where d.tenant_id = $1 and d.active = true
      group by d.id, d.distributor_name, d.zone, d.region, d.area
      `,
      [tenantId, range.start, range.end]
    );
    for (const row of distributorRows) {
      for (const [metricKey, metricValue, unit] of [
        ['revenue_mtd', Number(row.revenue_mtd || 0), 'currency'],
        ['orders_mtd', Number(row.orders_mtd || 0), 'number'],
        ['outstanding', Number(row.total_outstanding || 0), 'currency'],
        ['mtd_outstanding', Number(row.mtd_outstanding || 0), 'currency']
      ] as Array<[string, number, string]>) {
        await this.insertSnapshotMetric(runner, {
          tenantId,
          entityType: 'distributor',
          entityId: row.entity_id,
          entityName: row.entity_name,
          metricKey,
          metricValue,
          metricUnit: unit,
          snapshotDate: range.end,
          periodStart: range.start,
          periodEnd: range.end,
          zone: row.zone,
          region: row.region,
          area: row.area
        });
      }
    }

    const geographyRows = await runner.query(
      `
      with geo_orders as (
        select
          coalesce(o.region, o.zone, 'Unknown') as geo_key,
          coalesce(o.region, o.zone, 'Unknown') as geo_name,
          max(o.zone) as zone,
          max(o.region) as region,
          max(o.area) as area,
          coalesce(sum(so.net_amount), 0) as revenue_mtd,
          coalesce(sum(so.collections_amount), 0) as collection_mtd,
          count(distinct so.id) as orders_mtd,
          count(distinct so.outlet_id) as billed_outlets
        from sales_orders so
        join outlets o on o.id = so.outlet_id
        where so.tenant_id = $1 and so.order_sale_date between $2::date and $3::date
        group by coalesce(o.region, o.zone, 'Unknown')
      ),
      geo_outlets as (
        select
          coalesce(o.region, o.zone, 'Unknown') as geo_key,
          count(distinct to2.outlet_id) as total_outlets
        from tenant_outlets to2
        join outlets o on o.id = to2.outlet_id
        where to2.tenant_id = $1 and to2.active = true
        group by coalesce(o.region, o.zone, 'Unknown')
      )
      select
        go.geo_key,
        go.geo_name,
        go.zone,
        go.region,
        go.area,
        go.revenue_mtd,
        go.collection_mtd,
        go.orders_mtd,
        go.billed_outlets,
        coalesce(gout.total_outlets, 0) as total_outlets
      from geo_orders go
      left join geo_outlets gout on gout.geo_key = go.geo_key
      `,
      [tenantId, range.start, range.end]
    );
    for (const row of geographyRows) {
      const coverage = Number(row.total_outlets || 0) > 0 ? (Number(row.billed_outlets || 0) * 100) / Number(row.total_outlets || 1) : 0;
      for (const [metricKey, metricValue, unit] of [
        ['revenue_mtd', Number(row.revenue_mtd || 0), 'currency'],
        ['collection_mtd', Number(row.collection_mtd || 0), 'currency'],
        ['orders_mtd', Number(row.orders_mtd || 0), 'number'],
        ['coverage_pct', coverage, 'percent']
      ] as Array<[string, number, string]>) {
        await this.insertSnapshotMetric(runner, {
          tenantId,
          entityType: 'geography',
          entityId: row.geo_key,
          entityName: row.geo_name,
          metricKey,
          metricValue,
          metricUnit: unit,
          snapshotDate: range.end,
          periodStart: range.start,
          periodEnd: range.end,
          zone: row.zone,
          region: row.region,
          area: row.area
        });
      }
    }

    const peopleRows = await runner.query(
      `
      select
        p.id::text as entity_id,
        p.full_name as entity_name,
        p.zone, p.region, p.area,
        coalesce(sum(so.net_amount), 0) as revenue_mtd,
        coalesce(sum(so.collections_amount), 0) as collection_mtd,
        count(distinct so.id) as orders_mtd
      from people p
      left join salesmen s
        on s.tenant_id = p.tenant_id
        and (s.employee_code = p.person_code or lower(s.salesman_name) = lower(p.full_name))
      left join sales_orders so
        on so.salesman_id = s.id and so.tenant_id = p.tenant_id and so.order_sale_date between $2::date and $3::date
      where p.tenant_id = $1 and p.active = true
      group by p.id, p.full_name, p.zone, p.region, p.area
      `,
      [tenantId, range.start, range.end]
    );
    for (const row of peopleRows) {
      for (const [metricKey, metricValue, unit] of [
        ['revenue_mtd', Number(row.revenue_mtd || 0), 'currency'],
        ['collection_mtd', Number(row.collection_mtd || 0), 'currency'],
        ['orders_mtd', Number(row.orders_mtd || 0), 'number']
      ] as Array<[string, number, string]>) {
        await this.insertSnapshotMetric(runner, {
          tenantId,
          entityType: 'person',
          entityId: row.entity_id,
          entityName: row.entity_name,
          metricKey,
          metricValue,
          metricUnit: unit,
          snapshotDate: range.end,
          periodStart: range.start,
          periodEnd: range.end,
          zone: row.zone,
          region: row.region,
          area: row.area
        });
      }
    }
  }

  private evaluateOperator(operator: string, observed: number, threshold: number): boolean {
    if (operator === 'LT') return observed < threshold;
    if (operator === 'LTE') return observed <= threshold;
    if (operator === 'GT') return observed > threshold;
    if (operator === 'GTE') return observed >= threshold;
    return false;
  }

  private resolveWindowRange(windowType: string, asOfDate: string): { startDate: string; endDate: string } {
    let startDate = asOfDate;
    if (windowType === 'ROLLING_7D') {
      startDate = shiftDate(asOfDate, -6);
    } else if (windowType === 'ROLLING_30D') {
      startDate = shiftDate(asOfDate, -29);
    } else if (windowType === 'QTD') {
      startDate = startOfQuarter(asOfDate);
    } else if (windowType === 'YTD') {
      startDate = startOfYear(asOfDate);
    } else {
      startDate = startOfMonth(asOfDate);
    }

    return {
      startDate,
      endDate: asOfDate
    };
  }

  private normalizeZone(value: unknown): string {
    const normalized = String(value || '')
      .trim()
      .toUpperCase();
    return normalized || 'NATIONAL';
  }

  private async evaluateSignalsInternal(runner: QueryRunner, tenantId: number, triggeredBy: string): Promise<number> {
    const runToken = Date.now();
    const existingSignals = await runner.query(`select source_key, action_state from entity_signals where tenant_id = $1`, [tenantId]);
    const existingActionStateBySourceKey = new Map<string, string>();
    for (const signal of existingSignals) {
      if (signal?.source_key) {
        existingActionStateBySourceKey.set(String(signal.source_key), String(signal.action_state || 'new'));
      }
    }
    await runner.query(`delete from entity_signals where tenant_id = $1`, [tenantId]);
    const latestDateRows = await runner.query(`select max(snapshot_date) as latest_date from entity_metric_snapshots where tenant_id = $1`, [
      tenantId
    ]);
    const latestDate = toDateOnly(latestDateRows[0]?.latest_date);
    if (!latestDate) {
      return runToken;
    }

    const definitions = await runner.query(`select * from signal_definitions where active = true order by entity_type, signal_key`);
    for (const def of definitions) {
      const range = this.resolveWindowRange(String(def.window_type || 'MTD'), latestDate);
      const snapshotRows = await runner.query(
        `
        select distinct on (entity_id)
          entity_id, entity_name, zone, region, area, metric_value, snapshot_date
        from entity_metric_snapshots
        where tenant_id = $1
          and entity_type = $2
          and metric_key = $3
          and snapshot_date between $4::date and $5::date
        order by entity_id, snapshot_date desc
        `,
        [tenantId, def.entity_type, def.metric_key, range.startDate, range.endDate]
      );

      for (const snapshot of snapshotRows) {
        const zone = this.normalizeZone(snapshot.zone);
        let thresholdRows = await runner.query(
          `
            select threshold_value, is_enabled
            from tenant_signal_thresholds
            where tenant_id = $1 and signal_definition_id = $2 and upper(zone) = upper($3)
            limit 1
          `,
          [tenantId, def.id, zone]
        );
        if (!thresholdRows.length && zone !== 'NATIONAL') {
          thresholdRows = await runner.query(
            `
              select threshold_value, is_enabled
              from tenant_signal_thresholds
              where tenant_id = $1 and signal_definition_id = $2 and upper(zone) = 'NATIONAL'
              limit 1
            `,
            [tenantId, def.id]
          );
        }

        const chosen = thresholdRows[0];
        if (!chosen || chosen.is_enabled === false) {
          continue;
        }

        const observedValue = Number(snapshot.metric_value || 0);
        const thresholdValue = Number(chosen.threshold_value || 0);
        if (!this.evaluateOperator(def.comparison_operator, observedValue, thresholdValue)) {
          continue;
        }
        const sourceKey = this.buildSignalSourceKey(String(def.entity_type), String(snapshot.entity_id || ''), String(def.signal_key || ''));
        const actionState = existingActionStateBySourceKey.get(sourceKey) || 'new';

        await runner.query(
          `
            insert into entity_signals (
              tenant_id, signal_definition_id, entity_type, entity_id, entity_name, severity, signal_key, headline,
              description, metric_key, observed_value, threshold_value, comparison_operator, breach_amount, zone, region, area,
              source_key, action_state,
              window_start_date, window_end_date, metadata
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::date,$21::date,$22::jsonb)
          `,
          [
            tenantId,
            def.id,
            def.entity_type,
            snapshot.entity_id,
            snapshot.entity_name,
            def.default_severity,
            def.signal_key,
            `${def.signal_key} breached`,
            `${def.metric_key} is ${observedValue}, threshold ${thresholdValue}`,
            def.metric_key,
            observedValue,
            thresholdValue,
            def.comparison_operator,
            Math.abs(observedValue - thresholdValue),
            snapshot.zone || null,
            snapshot.region || null,
            snapshot.area || null,
            sourceKey,
            actionState,
            range.startDate,
            range.endDate,
            JSON.stringify({
              runToken,
              triggeredBy,
              windowType: def.window_type,
              snapshotDate: snapshot.snapshot_date
            })
          ]
        );
      }
    }

    return runToken;
  }

  private readOrdersBookText(row: OrdersBookRow, key: OrdersBookHeader): string {
    const value = row[key];
    return value === undefined || value === null ? '' : String(value).trim();
  }

  private readOrdersBookNumber(row: OrdersBookRow, key: OrdersBookHeader): number | null {
    return toNumber(row[key]);
  }

  private readOrdersBookDate(row: OrdersBookRow, key: OrdersBookHeader): string | null {
    return toDateOnly(row[key]);
  }

  private readOrdersBookTimestamp(row: OrdersBookRow, key: OrdersBookHeader): string | null {
    const value = this.readOrdersBookText(row, key);
    if (!value) {
      return null;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed.toISOString();
  }

  private parseOrdersBook(buffer: Buffer, filename: string): { headers: string[]; rows: OrdersBookRow[] } {
    const lower = filename.toLowerCase();
    if (!lower.endsWith('.xlsx')) {
      throw new Error('Only .xlsx files are supported for imports');
    }

    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    // Sheet name is not enforced — use the workbook's first sheet so the user
    // can name the tab whatever they like. Column names are the contract.
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      throw new Error('Workbook contains no sheets');
    }
    const worksheet = workbook.Sheets[sheetName];
    const headerRows = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1, raw: false, blankrows: false });
    const headers = (headerRows[0] || []).map((value) => String(value || '').trim());
    const rows = XLSX.utils.sheet_to_json<OrdersBookRow>(worksheet, { defval: '', raw: false });
    return { headers, rows };
  }

  private parseOrdersBookHeaders(buffer: Buffer, filename: string): string[] {
    const lower = filename.toLowerCase();
    if (!lower.endsWith('.xlsx')) {
      throw new Error('Only .xlsx files are supported for imports');
    }

    // sheetRows: 2 limits the parser to the header row + a sentinel — orders of
    // magnitude faster than reading the full workbook on a 10MB+ file.
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, sheetRows: 2 });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      throw new Error('Workbook contains no sheets');
    }
    const worksheet = workbook.Sheets[sheetName];
    const headerRows = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1, raw: false, blankrows: false });
    return (headerRows[0] || []).map((value) => String(value || '').trim());
  }

  private nullableText(value: string): string | null {
    return value ? value : null;
  }

  private normalizeOrdersBookRows(rows: OrdersBookRow[]): NormalizedOrdersBookRow[] {
    return rows.map((row, index) => {
      const distributor_code = this.readOrdersBookText(row, 'distributors.distributor_code');
      const distributor_zone = this.nullableText(this.readOrdersBookText(row, 'distributors.zone'));
      const distributor_region = this.nullableText(this.readOrdersBookText(row, 'distributors.region'));
      const distributor_area = this.nullableText(this.readOrdersBookText(row, 'distributors.area'));
      const salesman_zone =
        this.nullableText(this.readOrdersBookText(row, 'salesmen.zone')) || distributor_zone;
      const salesman_region =
        this.nullableText(this.readOrdersBookText(row, 'salesmen.region')) || distributor_region;
      const salesman_area =
        this.nullableText(this.readOrdersBookText(row, 'salesmen.area')) || distributor_area;
      const outlet_zone =
        this.nullableText(this.readOrdersBookText(row, 'outlets.zone')) || distributor_zone;
      const outlet_region =
        this.nullableText(this.readOrdersBookText(row, 'outlets.region')) || distributor_region;
      const outlet_area =
        this.nullableText(this.readOrdersBookText(row, 'outlets.area')) || distributor_area;
      const external_invoice_no = this.nullableText(this.readOrdersBookText(row, 'sales_orders.external_invoice_no'));
      const external_order_id = this.nullableText(this.readOrdersBookText(row, 'sales_orders.external_order_id'));
      const payment_external_ref = this.nullableText(this.readOrdersBookText(row, 'order_payments.external_ref'));
      const payment_date = this.readOrdersBookDate(row, 'order_payments.payment_date');
      const payment_mode = this.nullableText(this.readOrdersBookText(row, 'order_payments.payment_mode'));
      const payment_amount = this.readOrdersBookNumber(row, 'order_payments.amount');
      const orderIdentity = external_invoice_no ? `INV:${external_invoice_no}` : `ORD:${external_order_id || ''}`;
      const payment_identity =
        payment_external_ref
          ? `REF:${payment_external_ref}`
          : payment_amount !== null && payment_amount > 0
            ? `${orderIdentity}|DATE:${payment_date || ''}|MODE:${payment_mode || ''}|AMT:${String(payment_amount)}`
            : null;

      return {
        source_row_number: index + 2,
        s_no: this.readOrdersBookText(row, 'S.no') || String(index + 1),
        distributor_code,
        distributor_name: this.readOrdersBookText(row, 'distributors.distributor_name') || distributor_code,
        distributor_zone,
        distributor_region,
        distributor_area,
        beat_code: this.readOrdersBookText(row, 'beats.beat_code'),
        beat_name: this.readOrdersBookText(row, 'beats.beat_name') || this.readOrdersBookText(row, 'beats.beat_code'),
        salesman_code: this.readOrdersBookText(row, 'salesmen.salesman_code'),
        salesman_name:
          this.readOrdersBookText(row, 'salesmen.salesman_name') || this.readOrdersBookText(row, 'salesmen.salesman_code'),
        salesman_employee_code: this.nullableText(this.readOrdersBookText(row, 'salesmen.employee_code')),
        salesman_external_salesman_id: this.nullableText(this.readOrdersBookText(row, 'salesmen.external_salesman_id')),
        salesman_phone_number: normalizePhone(this.readOrdersBookText(row, 'salesmen.phone_number')) || null,
        salesman_zone,
        salesman_region,
        salesman_area,
        external_outlet_code: this.nullableText(this.readOrdersBookText(row, 'outlets.external_outlet_code')),
        outlet_name: this.nullableText(this.readOrdersBookText(row, 'outlets.outlet_name')),
        outlet_mobile_number: normalizePhone(this.readOrdersBookText(row, 'outlets.mobile_number')) || null,
        outlet_gst_number: this.nullableText(this.readOrdersBookText(row, 'outlets.gst_number')),
        outlet_address_line1: this.nullableText(this.readOrdersBookText(row, 'outlets.address_line1')),
        outlet_address_line2: this.nullableText(this.readOrdersBookText(row, 'outlets.address_line2')),
        outlet_pincode: this.nullableText(this.readOrdersBookText(row, 'outlets.pincode')),
        outlet_latitude: this.readOrdersBookNumber(row, 'outlets.latitude'),
        outlet_longitude: this.readOrdersBookNumber(row, 'outlets.longitude'),
        outlet_zone,
        outlet_region,
        outlet_area,
        tenant_outlet_code: this.readOrdersBookText(row, 'tenant_outlets.tenant_outlet_code'),
        brand_code: this.readOrdersBookText(row, 'brands.brand_code'),
        brand_name: this.readOrdersBookText(row, 'brands.brand_name') || this.readOrdersBookText(row, 'brands.brand_code'),
        sku_code: this.readOrdersBookText(row, 'skus.sku_code'),
        sku_name: this.readOrdersBookText(row, 'skus.name') || this.readOrdersBookText(row, 'skus.sku_code'),
        sku_hsn_code: this.nullableText(this.readOrdersBookText(row, 'skus.hsn_code')),
        sku_mrp: this.readOrdersBookNumber(row, 'skus.mrp'),
        sku_discount_amount: this.readOrdersBookNumber(row, 'skus.discount_amount'),
        sku_discount_percent: this.readOrdersBookNumber(row, 'skus.discount_percent'),
        sku_weight: this.readOrdersBookNumber(row, 'skus.weight'),
        sku_length_cm: this.readOrdersBookNumber(row, 'skus.length_cm'),
        sku_width_cm: this.readOrdersBookNumber(row, 'skus.width_cm'),
        sku_height_cm: this.readOrdersBookNumber(row, 'skus.height_cm'),
        sku_rate: this.readOrdersBookNumber(row, 'skus.rate'),
        sku_sgst_percent: this.readOrdersBookNumber(row, 'skus.sgst_percent'),
        sku_sgst_amount: this.readOrdersBookNumber(row, 'skus.sgst_amount'),
        sku_cgst_percent: this.readOrdersBookNumber(row, 'skus.cgst_percent'),
        sku_cgst_amount: this.readOrdersBookNumber(row, 'skus.cgst_amount'),
        sku_amount: this.readOrdersBookNumber(row, 'skus.amount'),
        sku_igst_percent: this.readOrdersBookNumber(row, 'skus.igst_percent'),
        sku_igst_amount: this.readOrdersBookNumber(row, 'skus.igst_amount'),
        external_order_id,
        external_invoice_no,
        external_awb_no: this.nullableText(this.readOrdersBookText(row, 'sales_orders.external_awb_no')),
        order_punched_at: this.readOrdersBookTimestamp(row, 'sales_orders.order_punched_at'),
        order_sale_date: this.readOrdersBookDate(row, 'sales_orders.order_sale_date'),
        order_gross_amount: this.readOrdersBookNumber(row, 'sales_orders.gross_amount'),
        order_discount_amount: this.readOrdersBookNumber(row, 'sales_orders.discount_amount'),
        order_tax_amount: this.readOrdersBookNumber(row, 'sales_orders.tax_amount'),
        order_net_amount: this.readOrdersBookNumber(row, 'sales_orders.net_amount'),
        order_collections_amount: this.readOrdersBookNumber(row, 'sales_orders.collections_amount'),
        order_outstanding_amount: this.readOrdersBookNumber(row, 'sales_orders.outstanding_amount'),
        order_decided_margin_amount: this.readOrdersBookNumber(row, 'sales_orders.decided_margin_amount'),
        order_remarks: this.nullableText(this.readOrdersBookText(row, 'sales_orders.remarks')),
        external_line_id: this.readOrdersBookText(row, 'sales_order_items.external_line_id'),
        ordered_quantity: this.readOrdersBookNumber(row, 'sales_order_items.ordered_quantity'),
        line_rate: this.readOrdersBookNumber(row, 'sales_order_items.rate'),
        line_discount_amount: this.readOrdersBookNumber(row, 'sales_order_items.discount_amount'),
        line_discount_percent: this.readOrdersBookNumber(row, 'sales_order_items.discount_percent'),
        line_sgst_percent: this.readOrdersBookNumber(row, 'sales_order_items.sgst_percent'),
        line_sgst_amount: this.readOrdersBookNumber(row, 'sales_order_items.sgst_amount'),
        line_cgst_percent: this.readOrdersBookNumber(row, 'sales_order_items.cgst_percent'),
        line_cgst_amount: this.readOrdersBookNumber(row, 'sales_order_items.cgst_amount'),
        line_igst_percent: this.readOrdersBookNumber(row, 'sales_order_items.igst_percent'),
        line_igst_amount: this.readOrdersBookNumber(row, 'sales_order_items.igst_amount'),
        line_tax_amount: this.readOrdersBookNumber(row, 'sales_order_items.tax_amount'),
        line_amount: this.readOrdersBookNumber(row, 'sales_order_items.amount'),
        payment_date,
        payment_mode,
        payment_amount,
        payment_external_ref,
        payment_identity
      };
    });
  }

  private validateOrdersBook(headers: string[], rows: NormalizedOrdersBookRow[]): ImportRowError[] {
    const errors: ImportRowError[] = [];
    if (!rows.length) {
      errors.push({
        sNo: 'HEADER',
        rowNumber: 1,
        column: 'orders_book',
        message: 'sheet has no data rows'
      });
      return errors;
    }

    const maxColumns = Math.max(headers.length, ORDERS_BOOK_HEADERS.length);
    for (let index = 0; index < maxColumns; index += 1) {
      const expected = ORDERS_BOOK_HEADERS[index] || '';
      const actual = headers[index] || '';
      if (expected !== actual) {
        errors.push({
          sNo: 'HEADER',
          rowNumber: 1,
          column: `col_${index + 1}`,
          message: `Expected "${expected}" but found "${actual}"`
        });
      }
    }

    const seenLineKeys = new Set<string>();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowNumber = row.source_row_number;
      const sNo = row.s_no || String(index + 1);
      const requiredTextColumns: Array<{ field: keyof NormalizedOrdersBookRow; column: string }> = [
        { field: 'distributor_code', column: 'distributors.distributor_code' },
        { field: 'beat_code', column: 'beats.beat_code' },
        { field: 'salesman_code', column: 'salesmen.salesman_code' },
        { field: 'external_outlet_code', column: 'outlets.external_outlet_code' },
        { field: 'tenant_outlet_code', column: 'tenant_outlets.tenant_outlet_code' },
        { field: 'brand_code', column: 'brands.brand_code' },
        { field: 'sku_code', column: 'skus.sku_code' },
        { field: 'external_line_id', column: 'sales_order_items.external_line_id' }
      ];

      for (const { field, column } of requiredTextColumns) {
        if (!String((row as Record<string, unknown>)[field] || '').trim()) {
          errors.push({
            sNo,
            rowNumber,
            column,
            message: 'is required'
          });
        }
      }

      const quantity = row.ordered_quantity;
      if (quantity === null || quantity <= 0) {
        errors.push({
          sNo,
          rowNumber,
          column: 'sales_order_items.ordered_quantity',
          message: 'must be a positive number'
        });
      }

      const invoiceNo = row.external_invoice_no || '';
      const orderId = row.external_order_id || '';
      if (!invoiceNo && !orderId) {
        errors.push({
          sNo,
          rowNumber,
          column: 'sales_orders.external_invoice_no|sales_orders.external_order_id',
          message: 'either external_invoice_no or external_order_id is required'
        });
      }

      const lineId = row.external_line_id;
      if (lineId) {
        const orderIdentity = invoiceNo ? `INV:${invoiceNo}` : `ORD:${orderId}`;
        const lineKey = `${orderIdentity}|${lineId}`;
        if (seenLineKeys.has(lineKey)) {
          errors.push({
            sNo,
            rowNumber,
            column: 'sales_order_items.external_line_id',
            message: `duplicate line key in file (${lineKey})`
          });
        } else {
          seenLineKeys.add(lineKey);
        }
      }
    }

    return errors;
  }

  private validateOrdersBookStructure(headers: string[], rows: OrdersBookRow[]): ImportRowError[] {
    const errors: ImportRowError[] = [];
    if (!rows.length) {
      errors.push({
        sNo: 'HEADER',
        rowNumber: 1,
        column: 'orders_book',
        message: 'sheet has no data rows'
      });
      return errors;
    }

    const maxColumns = Math.max(headers.length, ORDERS_BOOK_HEADERS.length);
    for (let index = 0; index < maxColumns; index += 1) {
      const expected = ORDERS_BOOK_HEADERS[index] || '';
      const actual = headers[index] || '';
      if (expected !== actual) {
        errors.push({
          sNo: 'HEADER',
          rowNumber: 1,
          column: `col_${index + 1}`,
          message: `Expected "${expected}" but found "${actual}"`
        });
      }
    }

    return errors;
  }

  private async downloadFromS3(objectKey: string): Promise<Buffer> {
    if (!env.S3_BUCKET) {
      throw Object.assign(new Error('S3_BUCKET is required for imports'), { statusCode: 500 });
    }

    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: objectKey
      })
    );
    const bytes = await response.Body?.transformToByteArray();
    if (!bytes) {
      throw new Error('Unable to read uploaded import file');
    }
    return Buffer.from(bytes);
  }

  private async createImportBatchRecord(payload: {
    tenantId: number;
    sourceFileName: string;
    fileChecksum: string | null;
    fileObjectKey: string | null;
    totalRows: number;
    totalColumns: number;
    importStatus: string;
    notes?: string | null;
    validRows?: number;
    rejectedRows?: number;
    errorCount?: number;
    startedAt?: boolean;
    completedAt?: boolean;
    processedBy?: string | null;
  }): Promise<number> {
    const rows = await this.db.query(
      `
      insert into import_batches (
        tenant_id, source_file_name, source_file_type, source_sheet_name, file_checksum, file_object_key,
        total_rows, total_columns, valid_rows, rejected_rows, error_count, import_status, notes, started_at, completed_at, processed_by
      )
      values (
        $1,$2,'xlsx','orders_book',$3,$4,$5,$6,$7,$8,$9,$10,$11,
        ${payload.startedAt ? 'now()' : 'null'},
        ${payload.completedAt ? 'now()' : 'null'},
        $12
      )
      returning id
      `,
      [
        payload.tenantId,
        payload.sourceFileName,
        payload.fileChecksum,
        payload.fileObjectKey,
        payload.totalRows,
        payload.totalColumns,
        payload.validRows ?? 0,
        payload.rejectedRows ?? 0,
        payload.errorCount ?? 0,
        payload.importStatus,
        payload.notes ?? null,
        payload.processedBy ?? null
      ]
    );
    return Number(rows[0]?.id);
  }

  private async insertImportErrors(batchId: number, errors: ImportRowError[], phase: ImportErrorPhase): Promise<void> {
    const limitedErrors = errors.slice(0, 1000);
    if (!limitedErrors.length) {
      return;
    }

    const valuesSql = limitedErrors
      .map(
        (_, index) =>
          `($1,$${index * 4 + 2},$${index * 4 + 3},$${index * 4 + 4},$${index * 4 + 5},$${limitedErrors.length * 4 + 2})`
      )
      .join(',');
    const params: Array<number | string> = [batchId];
    for (const error of limitedErrors) {
      params.push(error.rowNumber, error.sNo, error.column, error.message);
    }
    params.push(phase);

    await this.db.query(
      `
      insert into import_batch_errors (import_batch_id, row_number, s_no, column_name, message, phase)
      values ${valuesSql}
      `,
      params
    );
  }

  private async failImportBatch(
    batchId: number,
    summary: string,
    errors: ImportRowError[],
    phase: ImportErrorPhase,
    rejectedRows: number
  ): Promise<void> {
    try {
      await this.insertImportErrors(batchId, errors, phase);
    } catch (error) {
      console.log(`[import:${batchId}] insert_import_errors_failed phase=${phase}`, error);
      summary = `${summary} (error details unavailable)`;
    }
    // This UPDATE is the safety net — it MUST not throw. If it fails the batch
    // stays PROCESSING forever and the sweeper is the only recovery path.
    try {
      await this.db.query(
        `
        update import_batches
        set valid_rows = 0,
            rejected_rows = $2,
            total_rows = greatest(total_rows, $2),
            error_count = $3,
            import_status = 'FAILED',
            notes = $4,
            completed_at = now()
        where id = $1
        `,
        [batchId, rejectedRows, errors.length, summary]
      );
    } catch (error) {
      // Log and swallow — sweeper will auto-fail after timeout
      console.log(`[import:${batchId}] fail_batch_update_failed`, error);
    }
  }

  private normalizeReturnedRows<T = Record<string, any>>(result: any): T[] {
    if (!Array.isArray(result)) {
      return [];
    }
    if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
      return result[0] as T[];
    }
    return result as T[];
  }

  private normalizedReturnedRowCount(result: any): number {
    if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
      return result[1];
    }
    return this.normalizeReturnedRows(result).length;
  }

  private importBatchBaseSelect(): string {
    return `
      select
        ib.*,
        rj.id as refresh_job_id,
        rj.status as refresh_status,
        rj.requested_at as refresh_requested_at,
        rj.started_at as refresh_started_at,
        rj.completed_at as refresh_completed_at,
        rj.error_text as refresh_error
      from import_batches ib
      left join tenant_refresh_job_imports trji on trji.import_batch_id = ib.id
      left join tenant_refresh_jobs rj on rj.id = trji.refresh_job_id
    `;
  }

  private refreshJobSummaryFromRow(row: any): RefreshJobSummary {
    return {
      id: Number(row.id),
      status: String(row.status),
      requestedAt: row.requested_at || null,
      startedAt: row.started_at || null,
      completedAt: row.completed_at || null,
      error: row.error_text || null
    };
  }

  private importBatchSummaryFromRow(row: any): ImportBatchSummary {
    return {
      id: Number(row.id),
      tenantId: Number(row.tenant_id),
      sourceFileName: String(row.source_file_name),
      sourceFileType: row.source_file_type || null,
      sourceSheetName: row.source_sheet_name || null,
      fileChecksum: row.file_checksum || null,
      fileObjectKey: row.file_object_key || null,
      totalRows: Number(row.total_rows || 0),
      totalColumns: Number(row.total_columns || 0),
      validRows: Number(row.valid_rows || 0),
      rejectedRows: Number(row.rejected_rows || 0),
      errorCount: Number(row.error_count || 0),
      importStatus: String(row.import_status),
      notes: row.notes || null,
      startedAt: row.started_at || null,
      completedAt: row.completed_at || null,
      processedBy: row.processed_by || null,
      refreshJobId: row.refresh_job_id ? Number(row.refresh_job_id) : null,
      refreshStatus: row.refresh_status || null,
      refreshRequestedAt: row.refresh_requested_at || null,
      refreshStartedAt: row.refresh_started_at || null,
      refreshCompletedAt: row.refresh_completed_at || null,
      refreshError: row.refresh_error || null,
      importedAt: row.imported_at,
      createdAt: row.created_at
    };
  }

  private async getImportBatchById(importId: number): Promise<ImportBatchSummary | null> {
    const rows = await this.db.query(`${this.importBatchBaseSelect()} where ib.id = $1 limit 1`, [importId]);
    if (!rows.length) {
      return null;
    }
    return this.importBatchSummaryFromRow(rows[0]);
  }

  private async listImportErrors(batchId: number, limit = IMPORT_DETAIL_ERROR_LIMIT) {
    const rows = await this.db.query(
      `
      select row_number, s_no, column_name, message, phase, created_at
      from import_batch_errors
      where import_batch_id = $1
      order by id asc
      limit $2
      `,
      [batchId, limit]
    );

    return rows.map((row: any) => ({
      rowNumber: Number(row.row_number || 0),
      sNo: String(row.s_no || ''),
      column: String(row.column_name || ''),
      message: String(row.message || ''),
      phase: String(row.phase || ''),
      createdAt: row.created_at
    }));
  }

  private stageTableName(batchId: number): string {
    return `temp_import_rows_${batchId}`;
  }

  private newOutletMapTableName(batchId: number): string {
    return `temp_new_outlet_map_${batchId}`;
  }

  private csvValue(value: unknown): string {
    if (value === null || value === undefined) {
      return '\\N';
    }
    const stringValue = String(value);
    if (/["\n\r,]/.test(stringValue) || stringValue === '\\N') {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  }

  private csvLineForImportStage(row: NormalizedOrdersBookRow): string {
    return `${IMPORT_STAGE_COLUMNS.map((column) => this.csvValue(row[column])).join(',')}\n`;
  }

  protected async copyRowsIntoImportStage(
    runner: QueryRunner,
    stageTable: string,
    rows: NormalizedOrdersBookRow[]
  ): Promise<void> {
    const client = (runner as any).databaseConnection;
    if (!client?.query) {
      throw new Error('Postgres copy connection is unavailable');
    }

    const copySql = `copy ${stageTable} (${IMPORT_STAGE_COLUMNS.join(', ')}) from stdin with (format csv, null '\\N')`;
    async function* csvLines(service: SupeV1Service) {
      for (const row of rows) {
        yield service.csvLineForImportStage(row);
      }
    }

    await pipeline(Readable.from(csvLines(this)), client.query(copyFrom(copySql)));
    await this.indexImportStageTable(runner, stageTable);
  }

  private async createImportStageTable(runner: QueryRunner, stageTable: string): Promise<void> {
    // Create the temp table with no indexes — we'll bulk-COPY data first and
    // build indexes afterwards, which is orders of magnitude faster than
    // maintaining them during the COPY (standard PostgreSQL ETL pattern).
    await runner.query(
      `
      create temp table ${stageTable} (
        source_row_number int not null,
        s_no text not null,
        distributor_code text not null,
        distributor_name text not null,
        distributor_zone text,
        distributor_region text,
        distributor_area text,
        beat_code text not null,
        beat_name text not null,
        salesman_code text not null,
        salesman_name text not null,
        salesman_employee_code text,
        salesman_external_salesman_id text,
        salesman_phone_number text,
        salesman_zone text,
        salesman_region text,
        salesman_area text,
        external_outlet_code text,
        outlet_name text,
        outlet_mobile_number text,
        outlet_gst_number text,
        outlet_address_line1 text,
        outlet_address_line2 text,
        outlet_pincode text,
        outlet_latitude numeric(10,7),
        outlet_longitude numeric(10,7),
        outlet_zone text,
        outlet_region text,
        outlet_area text,
        tenant_outlet_code text not null,
        brand_code text not null,
        brand_name text not null,
        sku_code text not null,
        sku_name text not null,
        sku_hsn_code text,
        sku_mrp numeric(12,2),
        sku_discount_amount numeric(12,2),
        sku_discount_percent numeric(7,2),
        sku_weight numeric(12,3),
        sku_length_cm numeric(10,2),
        sku_width_cm numeric(10,2),
        sku_height_cm numeric(10,2),
        sku_rate numeric(12,2),
        sku_sgst_percent numeric(7,2),
        sku_sgst_amount numeric(12,2),
        sku_cgst_percent numeric(7,2),
        sku_cgst_amount numeric(12,2),
        sku_amount numeric(12,2),
        sku_igst_percent numeric(7,2),
        sku_igst_amount numeric(12,2),
        external_order_id text,
        external_invoice_no text,
        external_awb_no text,
        order_punched_at timestamptz,
        order_sale_date date,
        order_gross_amount numeric(14,2),
        order_discount_amount numeric(14,2),
        order_tax_amount numeric(14,2),
        order_net_amount numeric(14,2),
        order_collections_amount numeric(14,2),
        order_outstanding_amount numeric(14,2),
        order_decided_margin_amount numeric(14,2),
        order_remarks text,
        external_line_id text not null,
        ordered_quantity numeric(12,3) not null,
        line_rate numeric(12,2),
        line_discount_amount numeric(12,2),
        line_discount_percent numeric(7,2),
        line_sgst_percent numeric(7,2),
        line_sgst_amount numeric(12,2),
        line_cgst_percent numeric(7,2),
        line_cgst_amount numeric(12,2),
        line_igst_percent numeric(7,2),
        line_igst_amount numeric(12,2),
        line_tax_amount numeric(12,2),
        line_amount numeric(12,2),
        payment_date date,
        payment_mode text,
        payment_amount numeric(14,2),
        payment_external_ref text,
        payment_identity text
      ) on commit drop
      `
    );
  }

  private async indexImportStageTable(runner: QueryRunner, stageTable: string): Promise<void> {
    // Build all indexes after the bulk COPY — this is the industry-standard
    // PostgreSQL ETL pattern. Building indexes on an empty table and then
    // maintaining them row-by-row during COPY is 10-100x slower.
    const idx = (suffix: string, cols: string, extra = '') =>
      runner.query(`create index ${stageTable}_${suffix} on ${stageTable} (${cols}) ${extra}`);
    await Promise.all([
      idx('distributor_code', 'distributor_code'),
      idx('beat_code', 'beat_code'),
      idx('salesman_code', 'salesman_code'),
      idx('outlet_code', 'external_outlet_code, tenant_outlet_code'),
      idx('brand_code', 'brand_code'),
      idx('sku_code', 'sku_code'),
      idx('order_identity', 'external_invoice_no, external_order_id'),
      idx('payment_identity', 'payment_identity', 'where payment_identity is not null')
    ]);
    await runner.query(`analyze ${stageTable}`);
  }

  private orderIdentitySql(alias: string): string {
    return `case when ${alias}.external_invoice_no is not null then 'INV:' || ${alias}.external_invoice_no else 'ORD:' || ${alias}.external_order_id end`;
  }

  private async upsertDistributorsFromStage(runner: QueryRunner, stageTable: string, tenantId: number): Promise<void> {
    await runner.query(
      `
      with latest as (
        select distinct on (s.distributor_code)
          s.distributor_code,
          s.distributor_name,
          s.distributor_zone,
          s.distributor_region,
          s.distributor_area
        from ${stageTable} s
        order by s.distributor_code, s.source_row_number desc
      )
      insert into distributors (tenant_id, distributor_code, distributor_name, zone, region, area, active)
      select $1, latest.distributor_code, latest.distributor_name, latest.distributor_zone, latest.distributor_region, latest.distributor_area, true
      from latest
      on conflict (tenant_id, distributor_code)
      do update set
        distributor_name = excluded.distributor_name,
        zone = excluded.zone,
        region = excluded.region,
        area = excluded.area,
        active = true,
        updated_at = now()
      `,
      [tenantId]
    );
  }

  private async upsertBeatsFromStage(runner: QueryRunner, stageTable: string, tenantId: number): Promise<void> {
    await runner.query(
      `
      with latest as (
        select distinct on (s.beat_code)
          s.beat_code,
          s.beat_name,
          s.distributor_code,
          s.distributor_zone,
          s.distributor_region,
          s.distributor_area
        from ${stageTable} s
        order by s.beat_code, s.source_row_number desc
      )
      insert into beats (tenant_id, beat_code, beat_name, distributor_id, zone, region, area, active)
      select
        $1,
        latest.beat_code,
        latest.beat_name,
        d.id,
        latest.distributor_zone,
        latest.distributor_region,
        latest.distributor_area,
        true
      from latest
      join distributors d on d.tenant_id = $1 and d.distributor_code = latest.distributor_code
      on conflict (tenant_id, beat_code)
      do update set
        beat_name = excluded.beat_name,
        distributor_id = excluded.distributor_id,
        zone = excluded.zone,
        region = excluded.region,
        area = excluded.area,
        active = true,
        updated_at = now()
      `,
      [tenantId]
    );
  }

  private async upsertSalesmenFromStage(runner: QueryRunner, stageTable: string, tenantId: number): Promise<void> {
    await runner.query(
      `
      with latest as (
        select distinct on (s.salesman_code)
          s.salesman_code,
          s.salesman_name,
          s.salesman_employee_code,
          s.salesman_external_salesman_id,
          s.salesman_phone_number,
          s.salesman_zone,
          s.salesman_region,
          s.salesman_area,
          s.distributor_code
        from ${stageTable} s
        order by s.salesman_code, s.source_row_number desc
      )
      insert into salesmen (
        tenant_id,
        salesman_code,
        salesman_name,
        employee_code,
        external_salesman_id,
        phone_number,
        zone,
        region,
        area,
        distributor_id,
        active
      )
      select
        $1,
        latest.salesman_code,
        latest.salesman_name,
        latest.salesman_employee_code,
        latest.salesman_external_salesman_id,
        latest.salesman_phone_number,
        latest.salesman_zone,
        latest.salesman_region,
        latest.salesman_area,
        d.id,
        true
      from latest
      join distributors d on d.tenant_id = $1 and d.distributor_code = latest.distributor_code
      on conflict (tenant_id, salesman_code)
      do update set
        salesman_name = excluded.salesman_name,
        employee_code = excluded.employee_code,
        external_salesman_id = excluded.external_salesman_id,
        phone_number = excluded.phone_number,
        zone = excluded.zone,
        region = excluded.region,
        area = excluded.area,
        distributor_id = excluded.distributor_id,
        active = true,
        updated_at = now()
      `,
      [tenantId]
    );
  }

  private async upsertOutletsAndTenantOutletsFromStage(
    runner: QueryRunner,
    stageTable: string,
    batchId: number,
    tenantId: number
  ): Promise<void> {
    const newOutletMapTable = this.newOutletMapTableName(batchId);
    await runner.query(
      `
      create temp table ${newOutletMapTable} (
        tenant_outlet_code text primary key,
        outlet_id bigint not null
      ) on commit drop
      `
    );

    await runner.query(
      `
      with latest as (
        select distinct on (s.tenant_outlet_code)
          s.tenant_outlet_code,
          s.external_outlet_code,
          s.outlet_name,
          coalesce(s.outlet_name, s.external_outlet_code, s.tenant_outlet_code) as insert_outlet_name,
          s.outlet_mobile_number,
          s.outlet_gst_number,
          s.outlet_address_line1,
          s.outlet_address_line2,
          s.outlet_pincode,
          s.outlet_latitude,
          s.outlet_longitude,
          s.outlet_zone,
          s.outlet_region,
          s.outlet_area
        from ${stageTable} s
        order by s.tenant_outlet_code, s.source_row_number desc
      ),
      missing as (
        select
          latest.*,
          nextval(pg_get_serial_sequence('outlets', 'id')) as outlet_id
        from latest
        where not exists (
          select 1
          from tenant_outlets to2
          where to2.tenant_id = $1 and to2.tenant_outlet_code = latest.tenant_outlet_code
        )
      ),
      inserted as (
        insert into outlets (
          id,
          external_outlet_code,
          outlet_name,
          mobile_number,
          gst_number,
          address_line1,
          address_line2,
          pincode,
          latitude,
          longitude,
          zone,
          region,
          area,
          active
        )
        select
          missing.outlet_id,
          missing.external_outlet_code,
          missing.insert_outlet_name,
          missing.outlet_mobile_number,
          missing.outlet_gst_number,
          missing.outlet_address_line1,
          missing.outlet_address_line2,
          missing.outlet_pincode,
          missing.outlet_latitude,
          missing.outlet_longitude,
          missing.outlet_zone,
          missing.outlet_region,
          missing.outlet_area,
          true
        from missing
        returning id
      )
      insert into ${newOutletMapTable} (tenant_outlet_code, outlet_id)
      select missing.tenant_outlet_code, missing.outlet_id
      from missing
      `,
      [tenantId]
    );

    await runner.query(
      `
      with latest as (
        select distinct on (s.tenant_outlet_code)
          s.tenant_outlet_code,
          s.external_outlet_code,
          s.outlet_name,
          s.outlet_mobile_number,
          s.outlet_gst_number,
          s.outlet_address_line1,
          s.outlet_address_line2,
          s.outlet_pincode,
          s.outlet_latitude,
          s.outlet_longitude,
          s.outlet_zone,
          s.outlet_region,
          s.outlet_area
        from ${stageTable} s
        order by s.tenant_outlet_code, s.source_row_number desc
      ),
      resolved as (
        select
          latest.*,
          coalesce(to2.outlet_id, nom.outlet_id) as outlet_id
        from latest
        left join tenant_outlets to2 on to2.tenant_id = $1 and to2.tenant_outlet_code = latest.tenant_outlet_code
        left join ${newOutletMapTable} nom on nom.tenant_outlet_code = latest.tenant_outlet_code
      )
      update outlets o
      set external_outlet_code = resolved.external_outlet_code,
          outlet_name = resolved.outlet_name,
          mobile_number = resolved.outlet_mobile_number,
          gst_number = resolved.outlet_gst_number,
          address_line1 = resolved.outlet_address_line1,
          address_line2 = resolved.outlet_address_line2,
          pincode = resolved.outlet_pincode,
          latitude = resolved.outlet_latitude,
          longitude = resolved.outlet_longitude,
          zone = resolved.outlet_zone,
          region = resolved.outlet_region,
          area = resolved.outlet_area,
          active = true,
          updated_at = now()
      from resolved
      where o.id = resolved.outlet_id
      `,
      [tenantId]
    );

    await runner.query(
      `
      with latest as (
        select distinct on (s.tenant_outlet_code)
          s.tenant_outlet_code,
          s.salesman_code,
          s.distributor_code,
          s.order_sale_date
        from ${stageTable} s
        order by s.tenant_outlet_code, s.source_row_number desc
      ),
      resolved as (
        select
          latest.tenant_outlet_code,
          coalesce(to_existing.outlet_id, nom.outlet_id) as outlet_id,
          sm.id as salesman_id,
          d.id as distributor_id,
          latest.order_sale_date
        from latest
        left join tenant_outlets to_existing on to_existing.tenant_id = $1 and to_existing.tenant_outlet_code = latest.tenant_outlet_code
        left join ${newOutletMapTable} nom on nom.tenant_outlet_code = latest.tenant_outlet_code
        join salesmen sm on sm.tenant_id = $1 and sm.salesman_code = latest.salesman_code
        join distributors d on d.tenant_id = $1 and d.distributor_code = latest.distributor_code
      )
      insert into tenant_outlets (
        tenant_id,
        outlet_id,
        tenant_outlet_code,
        salesman_id,
        distributor_id,
        servicing_status,
        active,
        first_order_date,
        last_order_date
      )
      select
        $1,
        resolved.outlet_id,
        resolved.tenant_outlet_code,
        resolved.salesman_id,
        resolved.distributor_id,
        'active',
        true,
        resolved.order_sale_date,
        resolved.order_sale_date
      from resolved
      on conflict (tenant_id, tenant_outlet_code)
      do update set
        outlet_id = excluded.outlet_id,
        salesman_id = excluded.salesman_id,
        distributor_id = excluded.distributor_id,
        servicing_status = coalesce(excluded.servicing_status, tenant_outlets.servicing_status),
        active = true,
        first_order_date = coalesce(tenant_outlets.first_order_date, excluded.first_order_date),
        last_order_date = coalesce(excluded.last_order_date, tenant_outlets.last_order_date),
        updated_at = now()
      `,
      [tenantId]
    );

    await runner.query(
      `
      with latest as (
        select distinct on (s.tenant_outlet_code)
          s.tenant_outlet_code,
          s.beat_code
        from ${stageTable} s
        order by s.tenant_outlet_code, s.source_row_number desc
      ),
      resolved as (
        select
          to2.outlet_id,
          b.id as beat_id
        from latest
        join tenant_outlets to2 on to2.tenant_id = $1 and to2.tenant_outlet_code = latest.tenant_outlet_code
        join beats b on b.tenant_id = $1 and b.beat_code = latest.beat_code
      )
      update beat_outlets bo
      set active = false,
          removed_at = now(),
          removed_by = 'ingestion',
          updated_at = now()
      from resolved
      where bo.tenant_id = $1
        and bo.outlet_id = resolved.outlet_id
        and bo.beat_id <> resolved.beat_id
        and bo.active = true
      `,
      [tenantId]
    );

    await runner.query(
      `
      with latest as (
        select distinct on (s.tenant_outlet_code)
          s.tenant_outlet_code,
          s.beat_code,
          s.order_punched_at
        from ${stageTable} s
        order by s.tenant_outlet_code, s.source_row_number desc
      ),
      resolved as (
        select
          to2.outlet_id,
          b.id as beat_id,
          latest.order_punched_at
        from latest
        join tenant_outlets to2 on to2.tenant_id = $1 and to2.tenant_outlet_code = latest.tenant_outlet_code
        join beats b on b.tenant_id = $1 and b.beat_code = latest.beat_code
      )
      insert into beat_outlets (tenant_id, beat_id, outlet_id, active, assigned_at, assigned_by, removed_at, removed_by)
      select
        $1,
        resolved.beat_id,
        resolved.outlet_id,
        true,
        coalesce(resolved.order_punched_at, now()),
        'ingestion',
        null,
        null
      from resolved
      on conflict (tenant_id, beat_id, outlet_id)
      do update set
        active = true,
        removed_at = null,
        removed_by = null,
        assigned_at = coalesce(beat_outlets.assigned_at, excluded.assigned_at),
        updated_at = now()
      `,
      [tenantId]
    );
  }

  private async upsertBrandsFromStage(runner: QueryRunner, stageTable: string, tenantId: number): Promise<void> {
    await runner.query(
      `
      with latest_by_code as (
        select distinct on (s.brand_code)
          s.brand_code,
          s.brand_name
        from ${stageTable} s
        order by s.brand_code, s.source_row_number desc
      )
      update brands b
      set brand_code = latest_by_code.brand_code,
          brand_name = latest_by_code.brand_name,
          active = true,
          updated_at = now()
      from latest_by_code
      where b.tenant_id = $1
        and b.brand_code = latest_by_code.brand_code
      `,
      [tenantId]
    );

    await runner.query(
      `
      with latest_by_code as (
        select distinct on (s.brand_code)
          s.brand_code,
          s.brand_name
        from ${stageTable} s
        order by s.brand_code, s.source_row_number desc
      ),
      unmatched_code as (
        select latest_by_code.*
        from latest_by_code
        where not exists (
          select 1
          from brands b
          where b.tenant_id = $1 and b.brand_code = latest_by_code.brand_code
        )
      ),
      latest_by_name as (
        select distinct on (lower(unmatched_code.brand_name))
          unmatched_code.brand_code,
          unmatched_code.brand_name
        from unmatched_code
        order by lower(unmatched_code.brand_name), unmatched_code.brand_code
      )
      update brands b
      set brand_code = latest_by_name.brand_code,
          brand_name = latest_by_name.brand_name,
          active = true,
          updated_at = now()
      from latest_by_name
      where b.tenant_id = $1
        and lower(b.brand_name) = lower(latest_by_name.brand_name)
      `,
      [tenantId]
    );

    await runner.query(
      `
      with latest_by_code as (
        select distinct on (s.brand_code)
          s.brand_code,
          s.brand_name
        from ${stageTable} s
        order by s.brand_code, s.source_row_number desc
      )
      insert into brands (tenant_id, brand_code, brand_name, active)
      select $1, latest_by_code.brand_code, latest_by_code.brand_name, true
      from latest_by_code
      where not exists (
              select 1
              from brands b
              where b.tenant_id = $1 and b.brand_code = latest_by_code.brand_code
            )
        and not exists (
              select 1
              from brands b
              where b.tenant_id = $1 and lower(b.brand_name) = lower(latest_by_code.brand_name)
            )
      `,
      [tenantId]
    );
  }

  private async upsertSkusFromStage(runner: QueryRunner, stageTable: string, tenantId: number): Promise<void> {
    await runner.query(
      `
      with latest as (
        select distinct on (s.sku_code)
          s.*
        from ${stageTable} s
        order by s.sku_code, s.source_row_number desc
      ),
      resolved as (
        select
          latest.*,
          coalesce(bc.id, bn.id) as brand_id
        from latest
        left join brands bc on bc.tenant_id = $1 and bc.brand_code = latest.brand_code
        left join brands bn on bn.tenant_id = $1 and bc.id is null and lower(bn.brand_name) = lower(latest.brand_name)
      )
      insert into skus (
        tenant_id,
        sku_code,
        name,
        brand_id,
        hsn_code,
        mrp,
        discount_amount,
        discount_percent,
        rate,
        sgst_percent,
        sgst_amount,
        cgst_percent,
        cgst_amount,
        amount,
        weight,
        length_cm,
        width_cm,
        height_cm,
        igst_percent,
        igst_amount,
        active
      )
      select
        $1,
        resolved.sku_code,
        resolved.sku_name,
        resolved.brand_id,
        resolved.sku_hsn_code,
        resolved.sku_mrp,
        resolved.sku_discount_amount,
        resolved.sku_discount_percent,
        resolved.sku_rate,
        resolved.sku_sgst_percent,
        resolved.sku_sgst_amount,
        resolved.sku_cgst_percent,
        resolved.sku_cgst_amount,
        resolved.sku_amount,
        resolved.sku_weight,
        resolved.sku_length_cm,
        resolved.sku_width_cm,
        resolved.sku_height_cm,
        resolved.sku_igst_percent,
        resolved.sku_igst_amount,
        true
      from resolved
      on conflict (tenant_id, sku_code)
      do update set
        name = excluded.name,
        brand_id = excluded.brand_id,
        hsn_code = excluded.hsn_code,
        mrp = excluded.mrp,
        discount_amount = excluded.discount_amount,
        discount_percent = excluded.discount_percent,
        rate = excluded.rate,
        sgst_percent = excluded.sgst_percent,
        sgst_amount = excluded.sgst_amount,
        cgst_percent = excluded.cgst_percent,
        cgst_amount = excluded.cgst_amount,
        amount = excluded.amount,
        weight = excluded.weight,
        length_cm = excluded.length_cm,
        width_cm = excluded.width_cm,
        height_cm = excluded.height_cm,
        igst_percent = excluded.igst_percent,
        igst_amount = excluded.igst_amount,
        active = true,
        updated_at = now()
      `,
      [tenantId]
    );
  }

  private async upsertSalesOrdersFromStage(runner: QueryRunner, stageTable: string, tenantId: number, batchId: number): Promise<void> {
    const orderIdentity = this.orderIdentitySql('s');
    await runner.query(
      `
      with latest as (
        select distinct on (${orderIdentity})
          ${orderIdentity} as order_identity,
          s.*
        from ${stageTable} s
        order by ${orderIdentity}, s.source_row_number desc
      ),
      resolved as (
        select
          latest.*,
          o.id as outlet_id,
          to2.id as tenant_outlet_id,
          b.id as beat_id,
          sm.id as salesman_id,
          d.id as distributor_id
        from latest
        join tenant_outlets to2 on to2.tenant_id = $1 and to2.tenant_outlet_code = latest.tenant_outlet_code
        join outlets o on o.id = to2.outlet_id
        join beats b on b.tenant_id = $1 and b.beat_code = latest.beat_code
        join salesmen sm on sm.tenant_id = $1 and sm.salesman_code = latest.salesman_code
        join distributors d on d.tenant_id = $1 and d.distributor_code = latest.distributor_code
      ),
      updated as (
        update sales_orders so
        set import_batch_id = $2,
            external_order_id = resolved.external_order_id,
            external_invoice_no = resolved.external_invoice_no,
            external_awb_no = resolved.external_awb_no,
            order_punched_at = resolved.order_punched_at,
            order_sale_date = resolved.order_sale_date,
            outlet_id = resolved.outlet_id,
            tenant_outlet_id = resolved.tenant_outlet_id,
            beat_id = resolved.beat_id,
            salesman_id = resolved.salesman_id,
            distributor_id = resolved.distributor_id,
            gross_amount = resolved.order_gross_amount,
            discount_amount = resolved.order_discount_amount,
            tax_amount = resolved.order_tax_amount,
            net_amount = resolved.order_net_amount,
            collections_amount = resolved.order_collections_amount,
            outstanding_amount = resolved.order_outstanding_amount,
            decided_margin_amount = resolved.order_decided_margin_amount,
            remarks = resolved.order_remarks,
            updated_at = now()
        from resolved
        where so.tenant_id = $1
          and (
            (resolved.external_invoice_no is not null and so.external_invoice_no = resolved.external_invoice_no)
            or
            (resolved.external_invoice_no is null and so.external_order_id = resolved.external_order_id)
          )
        returning so.id
      )
      insert into sales_orders (
        tenant_id,
        import_batch_id,
        external_order_id,
        external_invoice_no,
        external_awb_no,
        order_punched_at,
        order_sale_date,
        outlet_id,
        tenant_outlet_id,
        beat_id,
        salesman_id,
        distributor_id,
        gross_amount,
        discount_amount,
        tax_amount,
        net_amount,
        collections_amount,
        outstanding_amount,
        decided_margin_amount,
        remarks
      )
      select
        $1,
        $2,
        resolved.external_order_id,
        resolved.external_invoice_no,
        resolved.external_awb_no,
        resolved.order_punched_at,
        resolved.order_sale_date,
        resolved.outlet_id,
        resolved.tenant_outlet_id,
        resolved.beat_id,
        resolved.salesman_id,
        resolved.distributor_id,
        resolved.order_gross_amount,
        resolved.order_discount_amount,
        resolved.order_tax_amount,
        resolved.order_net_amount,
        resolved.order_collections_amount,
        resolved.order_outstanding_amount,
        resolved.order_decided_margin_amount,
        resolved.order_remarks
      from resolved
      where not exists (
        select 1
        from sales_orders so
        where so.tenant_id = $1
          and (
            (resolved.external_invoice_no is not null and so.external_invoice_no = resolved.external_invoice_no)
            or
            (resolved.external_invoice_no is null and so.external_order_id = resolved.external_order_id)
          )
      )
      `,
      [tenantId, batchId]
    );
  }

  private async upsertSalesOrderItemsFromStage(runner: QueryRunner, stageTable: string, tenantId: number): Promise<void> {
    const orderIdentity = this.orderIdentitySql('s');
    await runner.query(
      `
      with latest as (
        select distinct on (${orderIdentity}, s.external_line_id)
          ${orderIdentity} as order_identity,
          s.*
        from ${stageTable} s
        order by ${orderIdentity}, s.external_line_id, s.source_row_number desc
      ),
      resolved as (
        select
          latest.*,
          so.id as sales_order_id,
          sku.id as sku_id
        from latest
        join sales_orders so
          on so.tenant_id = $1
         and (
           (latest.external_invoice_no is not null and so.external_invoice_no = latest.external_invoice_no)
           or
           (latest.external_invoice_no is null and so.external_order_id = latest.external_order_id)
         )
        join skus sku on sku.tenant_id = $1 and sku.sku_code = latest.sku_code
      )
      insert into sales_order_items (
        sales_order_id,
        sku_id,
        external_line_id,
        ordered_quantity,
        rate,
        discount_amount,
        discount_percent,
        sgst_percent,
        sgst_amount,
        cgst_percent,
        cgst_amount,
        igst_percent,
        igst_amount,
        tax_amount,
        amount
      )
      select
        resolved.sales_order_id,
        resolved.sku_id,
        resolved.external_line_id,
        resolved.ordered_quantity,
        resolved.line_rate,
        resolved.line_discount_amount,
        resolved.line_discount_percent,
        resolved.line_sgst_percent,
        resolved.line_sgst_amount,
        resolved.line_cgst_percent,
        resolved.line_cgst_amount,
        resolved.line_igst_percent,
        resolved.line_igst_amount,
        resolved.line_tax_amount,
        resolved.line_amount
      from resolved
      on conflict (sales_order_id, external_line_id) where external_line_id is not null
      do update set
        sku_id = excluded.sku_id,
        ordered_quantity = excluded.ordered_quantity,
        rate = excluded.rate,
        discount_amount = excluded.discount_amount,
        discount_percent = excluded.discount_percent,
        sgst_percent = excluded.sgst_percent,
        sgst_amount = excluded.sgst_amount,
        cgst_percent = excluded.cgst_percent,
        cgst_amount = excluded.cgst_amount,
        igst_percent = excluded.igst_percent,
        igst_amount = excluded.igst_amount,
        tax_amount = excluded.tax_amount,
        amount = excluded.amount
      `,
      [tenantId]
    );
  }

  private async upsertOrderPaymentsFromStage(runner: QueryRunner, stageTable: string, tenantId: number): Promise<void> {
    // `payment_identity` is pre-computed in Node before COPY and indexed on the
    // stage table after COPY.
    // Using it in DISTINCT ON / ORDER BY lets Postgres use that index instead of
    // evaluating a bare CASE expression on every row (which forced a full seq-scan).
    //
    // Pattern: UPDATE existing rows first, then INSERT only net-new rows.
    // Both share the same `latest` CTE that de-duplicates via the indexed column.

    // ── 1. UPDATE existing payments ────────────────────────────────────────────
    await runner.query(
      `
      with latest as (
        -- De-duplicate: keep the last-row-wins record for each unique payment.
        -- DISTINCT ON uses the payment_identity index — no CASE expression at runtime.
        select distinct on (s.payment_identity)
          s.*
        from ${stageTable} s
        where s.payment_identity is not null
        order by s.payment_identity, s.source_row_number desc
      ),
      resolved as (
        -- Join to sales_orders to get the internal sales_order_id.
        -- idx_sales_orders_tenant_invoice / idx_sales_orders_tenant_order_id are used here.
        select
          latest.*,
          so.id as sales_order_id
        from latest
        join sales_orders so
          on so.tenant_id = $1
         and (
           (latest.external_invoice_no is not null and so.external_invoice_no = latest.external_invoice_no)
           or
           (latest.external_invoice_no is null and so.external_order_id = latest.external_order_id)
         )
      ),
      matched as (
        -- Find existing order_payments rows to update.
        -- idx_order_payments_tenant_ref and idx_order_payments_composite_match are used here.
        select
          resolved.source_row_number,
          op.id as payment_id
        from resolved
        join order_payments op
          on op.tenant_id = $1
         and op.sales_order_id = resolved.sales_order_id
         and (
           (resolved.payment_external_ref is not null and op.external_ref = resolved.payment_external_ref)
           or
           (
             resolved.payment_external_ref is null
             and op.external_ref is null
             and op.payment_date = resolved.payment_date
             and coalesce(op.payment_mode, '') = coalesce(resolved.payment_mode, '')
             and op.amount = resolved.payment_amount
           )
         )
      )
      update order_payments op
      set payment_date = resolved.payment_date,
          payment_mode = resolved.payment_mode,
          amount       = resolved.payment_amount,
          external_ref = resolved.payment_external_ref
      from resolved
      join matched on matched.source_row_number = resolved.source_row_number
      where op.id = matched.payment_id
      `,
      [tenantId]
    );

    // ── 2. INSERT net-new payments ─────────────────────────────────────────────
    await runner.query(
      `
      with latest as (
        select distinct on (s.payment_identity)
          s.*
        from ${stageTable} s
        where s.payment_identity is not null
        order by s.payment_identity, s.source_row_number desc
      ),
      resolved as (
        select
          latest.*,
          so.id as sales_order_id
        from latest
        join sales_orders so
          on so.tenant_id = $1
         and (
           (latest.external_invoice_no is not null and so.external_invoice_no = latest.external_invoice_no)
           or
           (latest.external_invoice_no is null and so.external_order_id = latest.external_order_id)
         )
      )
      insert into order_payments (
        tenant_id,
        sales_order_id,
        payment_date,
        payment_mode,
        amount,
        external_ref
      )
      select
        $1,
        resolved.sales_order_id,
        resolved.payment_date,
        resolved.payment_mode,
        resolved.payment_amount,
        resolved.payment_external_ref
      from resolved
      where not exists (
        select 1
        from order_payments op
        where op.tenant_id = $1
          and op.sales_order_id = resolved.sales_order_id
          and (
            (resolved.payment_external_ref is not null and op.external_ref = resolved.payment_external_ref)
            or
            (
              resolved.payment_external_ref is null
              and op.external_ref is null
              and op.payment_date = resolved.payment_date
              and coalesce(op.payment_mode, '') = coalesce(resolved.payment_mode, '')
              and op.amount = resolved.payment_amount
            )
          )
      )
      `,
      [tenantId]
    );
  }

  private async attachImportToRefreshJob(
    runner: QueryRunner,
    tenantId: number,
    batchId: number
  ): Promise<RefreshJobSummary> {
    const queuedRows = await runner.query(
      `
      select id, status, requested_at, started_at, completed_at, error_text
      from tenant_refresh_jobs
      where tenant_id = $1 and status = 'QUEUED'
      order by requested_at asc
      for update
      limit 1
      `,
      [tenantId]
    );
    if (queuedRows.length) {
      const queued = this.refreshJobSummaryFromRow(queuedRows[0]);
      await runner.query(
        `
        insert into tenant_refresh_job_imports (refresh_job_id, import_batch_id)
        values ($1, $2)
        on conflict (import_batch_id)
        do update set refresh_job_id = excluded.refresh_job_id
        `,
        [queued.id, batchId]
      );
      return queued;
    }

    const runningRows = await runner.query(
      `
      select id, status, requested_at, started_at, completed_at, error_text
      from tenant_refresh_jobs
      where tenant_id = $1 and status = 'RUNNING'
      order by started_at asc
      for update
      limit 1
      `,
      [tenantId]
    );
    if (runningRows.length) {
      const running = this.refreshJobSummaryFromRow(runningRows[0]);
      await runner.query(
        `
        update tenant_refresh_jobs
        set rerun_requested = true,
            updated_at = now()
        where id = $1
        `,
        [running.id]
      );
      await runner.query(
        `
        insert into tenant_refresh_job_imports (refresh_job_id, import_batch_id)
        values ($1, $2)
        on conflict (import_batch_id)
        do update set refresh_job_id = excluded.refresh_job_id
        `,
        [running.id, batchId]
      );
      return running;
    }

    try {
      const createdRows = await runner.query(
        `
        insert into tenant_refresh_jobs (tenant_id, status, trigger_metadata)
        values ($1, 'QUEUED', $2::jsonb)
        returning id, status, requested_at, started_at, completed_at, error_text
        `,
        [tenantId, JSON.stringify({ trigger: 'import', importBatchId: batchId })]
      );
      const created = this.refreshJobSummaryFromRow(createdRows[0]);
      await runner.query(
        `
        insert into tenant_refresh_job_imports (refresh_job_id, import_batch_id)
        values ($1, $2)
        on conflict (import_batch_id)
        do update set refresh_job_id = excluded.refresh_job_id
        `,
        [created.id, batchId]
      );
      return created;
    } catch (error: any) {
      const retriedRows = await runner.query(
        `
        select id, status, requested_at, started_at, completed_at, error_text
        from tenant_refresh_jobs
        where tenant_id = $1 and status in ('QUEUED', 'RUNNING')
        order by case status when 'RUNNING' then 0 else 1 end, requested_at asc
        limit 1
        `,
        [tenantId]
      );
      if (!retriedRows.length) {
        throw error;
      }
      const existing = this.refreshJobSummaryFromRow(retriedRows[0]);
      await runner.query(
        `
        insert into tenant_refresh_job_imports (refresh_job_id, import_batch_id)
        values ($1, $2)
        on conflict (import_batch_id)
        do update set refresh_job_id = excluded.refresh_job_id
        `,
        [existing.id, batchId]
      );
      return existing;
    }
  }

  private async createInlineRefreshJob(
    runner: QueryRunner,
    tenantId: number,
    batchId: number
  ): Promise<RefreshJobSummary> {
    const rows = await runner.query(
      `
      insert into tenant_refresh_jobs (
        tenant_id,
        status,
        started_at,
        trigger_metadata
      )
      values ($1, 'RUNNING', now(), $2::jsonb)
      returning id, status, requested_at, started_at, completed_at, error_text
      `,
      [tenantId, JSON.stringify({ trigger: 'inline_import_refresh', importBatchId: batchId })]
    );
    const refreshJob = this.refreshJobSummaryFromRow(rows[0]);
    await runner.query(
      `
      insert into tenant_refresh_job_imports (refresh_job_id, import_batch_id)
      values ($1, $2)
      on conflict (import_batch_id)
      do update set refresh_job_id = excluded.refresh_job_id
      `,
      [refreshJob.id, batchId]
    );
    return refreshJob;
  }

  private async finalizeInlineRefreshJob(
    runner: QueryRunner,
    refreshJobId: number,
    status: 'COMPLETED' | 'FAILED',
    errorText: string | null
  ): Promise<void> {
    await runner.query(
      `
      update tenant_refresh_jobs
      set status = $2,
          error_text = $3,
          completed_at = now(),
          updated_at = now()
      where id = $1
      `,
      [refreshJobId, status, errorText]
    );
  }

  private async finalizeRefreshJob(jobId: number, status: 'COMPLETED' | 'FAILED', errorText: string | null): Promise<void> {
    const runner = this.db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const rows = await runner.query(
        `
        select id, tenant_id, status, started_at, rerun_requested
        from tenant_refresh_jobs
        where id = $1
        for update
        `,
        [jobId]
      );
      if (!rows.length) {
        await runner.rollbackTransaction();
        return;
      }

      const row = rows[0];
      await runner.query(
        `
        update tenant_refresh_jobs
        set status = $2,
            error_text = $3,
            completed_at = now(),
            updated_at = now()
        where id = $1
        `,
        [jobId, status, errorText]
      );

      if (row.rerun_requested) {
        const createdRows = await runner.query(
          `
          insert into tenant_refresh_jobs (tenant_id, status, trigger_metadata)
          values ($1, 'QUEUED', $2::jsonb)
          returning id
          `,
          [Number(row.tenant_id), JSON.stringify({ trigger: 'rerun_after_running_job', previousRefreshJobId: jobId })]
        );
        const nextJobId = Number(createdRows[0]?.id || 0);
        if (nextJobId) {
          await runner.query(
            `
            update tenant_refresh_job_imports
            set refresh_job_id = $2
            where refresh_job_id = $1
              and created_at >= coalesce($3::timestamptz, now())
            `,
            [jobId, nextJobId, row.started_at]
          );
        }
      }

      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  private async persistOrdersBookRows(
    tenantId: number,
    batchId: number,
    rows: NormalizedOrdersBookRow[],
    triggeredBy: string
  ): Promise<ImportPublishResult> {
    await this.seedStaticData(tenantId);

    const runner = this.db.createQueryRunner();
    const stageTable = this.stageTableName(batchId);
    await runner.connect();
    await runner.startTransaction();
    try {
      await this.createImportStageTable(runner, stageTable);
      await this.copyRowsIntoImportStage(runner, stageTable, rows);
      console.log(`[import:${batchId}] copy_done rows=${rows.length}`);

      await this.upsertDistributorsFromStage(runner, stageTable, tenantId);
      console.log(`[import:${batchId}] upsert_distributors_done`);

      await this.upsertBeatsFromStage(runner, stageTable, tenantId);
      console.log(`[import:${batchId}] upsert_beats_done`);

      await this.upsertSalesmenFromStage(runner, stageTable, tenantId);
      console.log(`[import:${batchId}] upsert_salesmen_done`);

      await this.upsertOutletsAndTenantOutletsFromStage(runner, stageTable, batchId, tenantId);
      console.log(`[import:${batchId}] upsert_outlets_done`);

      await this.upsertBrandsFromStage(runner, stageTable, tenantId);
      console.log(`[import:${batchId}] upsert_brands_done`);

      await this.upsertSkusFromStage(runner, stageTable, tenantId);
      console.log(`[import:${batchId}] upsert_skus_done`);

      await this.upsertSalesOrdersFromStage(runner, stageTable, tenantId, batchId);
      console.log(`[import:${batchId}] upsert_orders_done`);

      await this.upsertSalesOrderItemsFromStage(runner, stageTable, tenantId);
      console.log(`[import:${batchId}] upsert_order_items_done`);

      await this.upsertOrderPaymentsFromStage(runner, stageTable, tenantId);
      console.log(`[import:${batchId}] upsert_payments_done`);

      const refreshJob = await this.createInlineRefreshJob(runner, tenantId, batchId);
      console.log(`[import:${batchId}] refresh_job_started job_id=${refreshJob.id} status=${refreshJob.status}`);

      await this.refreshSnapshots(runner, tenantId);
      console.log(`[import:${batchId}] refresh_snapshots_done`);

      const signalRunId = await this.evaluateSignalsInternal(runner, tenantId, triggeredBy);
      console.log(`[import:${batchId}] refresh_signals_done signal_run=${signalRunId}`);

      await this.recomputeTargetProgressInternal(runner, tenantId);
      console.log(`[import:${batchId}] refresh_targets_done`);

      await this.finalizeInlineRefreshJob(runner, refreshJob.id, 'COMPLETED', null);
      console.log(`[import:${batchId}] refresh_job_completed job_id=${refreshJob.id}`);

      await runner.commitTransaction();
      return {
        refreshJobId: refreshJob.id,
        signalRunId
      };
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  public async refreshTenantState(
    tenantId: number,
    triggeredBy: string
  ): Promise<{ signalRunId: number; catalog: CatalogRefreshResult }> {
    const tenant = await this.resolveTenantCatalogTarget(tenantId);
    await this.seedStaticData(tenant.id);

    const runner = this.db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    let signalRunId = 0;
    try {
      await this.refreshSnapshots(runner, tenant.id);
      signalRunId = await this.evaluateSignalsInternal(runner, tenant.id, triggeredBy);
      await this.recomputeTargetProgressInternal(runner, tenant.id);
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }

    const catalog = await this.refreshCatalogState(tenant, triggeredBy);
    return { signalRunId, catalog };
  }

  async createImport(user: IAuthUser | undefined, file: ImportableFile) {
    if (!env.S3_BUCKET) {
      throw Object.assign(new Error('S3_BUCKET is required for imports'), { statusCode: 500 });
    }

    const tenantId = await this.resolveTenantId(user);
    const tenantCode = this.resolveTenantCode(user);
    const buffer = await file.toBuffer();
    const fileChecksum = createHash('sha256').update(buffer).digest('hex');

    // Header-only parse keeps the request path fast on large workbooks. Full
    // row parsing, checksumming, and per-row validation happen in the worker
    // after the file lands in object storage.
    let headers: string[] = [];
    try {
      headers = this.parseOrdersBookHeaders(buffer, file.filename);
    } catch (error: any) {
      const parseErrors: ImportRowError[] = [
        {
          sNo: 'HEADER',
          rowNumber: 1,
          column: 'orders_book',
          message: String(error?.message || 'Unable to parse workbook')
        }
      ];
      const batchId = await this.createImportBatchRecord({
        tenantId,
        sourceFileName: file.filename,
        fileChecksum,
        fileObjectKey: null,
        totalRows: 0,
        totalColumns: 0,
        importStatus: 'FAILED',
        notes: 'Import prevalidation failed',
        rejectedRows: 0,
        errorCount: parseErrors.length,
        completedAt: true
      });
      await this.insertImportErrors(batchId, parseErrors, 'prevalidation');
      const validationError = new ImportValidationError('Import prevalidation failed', parseErrors);
      (validationError as any).batchId = batchId;
      throw validationError;
    }

    const prevalidationErrors = this.validateOrdersBookStructure(headers, [{} as OrdersBookRow]);
    if (prevalidationErrors.length) {
      const batchId = await this.createImportBatchRecord({
        tenantId,
        sourceFileName: file.filename,
        fileChecksum,
        fileObjectKey: null,
        totalRows: 0,
        totalColumns: headers.length,
        importStatus: 'FAILED',
        notes: 'Import prevalidation failed',
        rejectedRows: 0,
        errorCount: prevalidationErrors.length,
        completedAt: true
      });
      await this.insertImportErrors(batchId, prevalidationErrors, 'prevalidation');
      const validationError = new ImportValidationError('Import prevalidation failed', prevalidationErrors);
      (validationError as any).batchId = batchId;
      throw validationError;
    }

    // Header validated — now persist to S3 and queue the batch.
    const objectKey = await this.uploadToS3(tenantCode, file.filename, buffer, file.mimetype);
    const batchId = await this.createImportBatchRecord({
      tenantId,
      sourceFileName: file.filename,
      fileChecksum,
      fileObjectKey: objectKey,
      totalRows: 0,
      totalColumns: headers.length,
      importStatus: 'QUEUED'
    });

    return {
      batchId,
      status: 'QUEUED',
      totalRows: 0,
      totalColumns: headers.length
    };
  }

  async processNextQueuedImport(workerId: string): Promise<boolean> {
    const rawResult = await this.db.query(
      `
      with candidate as (
        select id
        from import_batches
        where import_status = 'QUEUED'
        order by created_at asc
        for update skip locked
        limit 1
      )
      update import_batches b
      set import_status = 'PROCESSING',
          started_at = now(),
          completed_at = null,
          processed_by = $1,
          notes = 'processing'
      from candidate
      where b.id = candidate.id
      returning b.id as id
      `,
      [workerId]
    );
    const rows = this.normalizeReturnedRows<{ id?: number | string; b_id?: number | string; 'b.id'?: number | string }>(rawResult);
    const claimedRowCount = this.normalizedReturnedRowCount(rawResult);

    const rawBatchId = rows[0]?.id ?? rows[0]?.b_id ?? rows[0]?.['b.id'] ?? 0;
    const batchId = Number(rawBatchId || 0);
    if (!batchId) {
      if (claimedRowCount > 0) {
        console.log('[import-worker] claimed batch but could not resolve batch id', rawResult);
      }
      return false;
    }

    const t0 = Date.now();
    const phase = async (name: string) => {
      console.log(`[import:${batchId}] phase=${name} elapsed_ms=${Date.now() - t0}`);
      try {
        await this.db.query(`update import_batches set notes = $2 where id = $1`, [batchId, name]);
      } catch (err) {
        console.log(`[import:${batchId}] phase-note-update-failed`, err);
      }
    };
    await phase('claimed');

    const batch = await this.getImportBatchById(batchId);
    if (!batch?.fileObjectKey) {
      await this.failImportBatch(
        batchId,
        'Import file is missing from object storage',
        [{ sNo: 'SYSTEM', rowNumber: 0, column: 'file', message: 'file_object_key is missing' }],
        'processing',
        batch?.totalRows || 0
      );
      return true;
    }

    let parsedRows: OrdersBookRow[] = [];
    let normalizedRows: NormalizedOrdersBookRow[] = [];
    let headers: string[] = [];
    try {
      await phase('s3_download');
      const buffer = await this.downloadFromS3(batch.fileObjectKey);
      console.log(`[import:${batchId}] s3_download_done bytes=${buffer.length}`);
      await phase('parse_workbook');
      const parsed = this.parseOrdersBook(buffer, batch.sourceFileName);
      headers = parsed.headers;
      parsedRows = parsed.rows;
      console.log(`[import:${batchId}] parse_workbook_done rows=${parsedRows.length} cols=${headers.length}`);
    } catch (error: any) {
      await this.failImportBatch(
        batchId,
        String(error?.message || 'Unable to download or parse queued import'),
        [{ sNo: 'SYSTEM', rowNumber: 0, column: 'file', message: String(error?.message || 'Queued import parse failed') }],
        'processing',
        batch.totalRows || 0
      );
      throw error;
    }

    await phase('normalize_rows');
    normalizedRows = this.normalizeOrdersBookRows(parsedRows);

    await phase('validate_rows');
    const validationErrors = this.validateOrdersBook(headers, normalizedRows);
    console.log(`[import:${batchId}] validate_rows_done errors=${validationErrors.length}`);
    if (validationErrors.length) {
      await this.failImportBatch(batchId, 'Import validation failed', validationErrors, 'validation', normalizedRows.length);
      return true;
    }

    try {
      await phase('persist_rows');
      const publishResult = await this.persistOrdersBookRows(batch.tenantId, batchId, normalizedRows, workerId);
      console.log(`[import:${batchId}] persist_rows_done`);
      await this.db.query(
        `
        update import_batches
        set total_rows = $2,
            total_columns = $3,
            valid_rows = $2,
            rejected_rows = 0,
            error_count = 0,
            import_status = 'COMPLETED',
            notes = $4,
            completed_at = now()
        where id = $1
        `,
        [
          batchId,
          normalizedRows.length,
          headers.length,
          publishResult.refreshJobId
            ? `Import committed; analytics refreshed (#${publishResult.refreshJobId})`
            : 'Import committed; analytics refreshed'
        ]
      );
    } catch (error: any) {
      await this.failImportBatch(
        batchId,
        String(error?.message || 'Import failed during processing'),
        [{ sNo: 'SYSTEM', rowNumber: 0, column: 'processing', message: String(error?.message || 'Import failed') }],
        'processing',
        normalizedRows.length
      );
      throw error;
    }

    return true;
  }

  async processNextQueuedRefreshJob(workerId: string): Promise<boolean> {
    const rawResult = await this.db.query(
      `
      with candidate as (
        select id
        from tenant_refresh_jobs
        where status = 'QUEUED'
        order by requested_at asc
        for update skip locked
        limit 1
      )
      update tenant_refresh_jobs trj
      set status = 'RUNNING',
          started_at = coalesce(started_at, now()),
          error_text = null,
          updated_at = now()
      from candidate
      where trj.id = candidate.id
      returning trj.id, trj.tenant_id
      `
    );
    const rows = this.normalizeReturnedRows<{ id?: number | string; tenant_id?: number | string }>(rawResult);
    const refreshJobId = Number(rows[0]?.id || 0);
    const tenantId = Number(rows[0]?.tenant_id || 0);
    if (!refreshJobId || !tenantId) {
      return false;
    }

    try {
      const result = await this.refreshTenantState(tenantId, workerId);
      await this.finalizeRefreshJob(refreshJobId, 'COMPLETED', null);
      console.log(
        `[refresh-job:${refreshJobId}] refresh_job_done signal_run=${result.signalRunId} catalog_tables=${result.catalog.refreshedTables}`
      );
    } catch (error: any) {
      const errorMessage = String(error?.message || 'unknown error');
      await this.finalizeRefreshJob(refreshJobId, 'FAILED', errorMessage);
      console.log(`[refresh-job:${refreshJobId}] refresh_job_failed error=${errorMessage}`);
    }

    return true;
  }

  async listImports(user: IAuthUser | undefined, limit = 20) {
    const tenantId = await this.resolveTenantId(user);
    const rows = await this.db.query(
      `
      ${this.importBatchBaseSelect()}
      where ib.tenant_id = $1
      order by ib.created_at desc
      limit $2
      `,
      [tenantId, limit]
    );
    return rows.map((row: any) => this.importBatchSummaryFromRow(row));
  }

  async getImportById(user: IAuthUser | undefined, importId: number) {
    const tenantId = await this.resolveTenantId(user);
    const rows = await this.db.query(`${this.importBatchBaseSelect()} where ib.id = $1 and ib.tenant_id = $2 limit 1`, [importId, tenantId]);
    if (!rows.length) {
      throw new Error('Import not found');
    }

    return {
      ...this.importBatchSummaryFromRow(rows[0]),
      errors: await this.listImportErrors(importId)
    };
  }

  async cancelImport(user: IAuthUser | undefined, importId: number): Promise<{ cancelled: boolean }> {
    // Soft-cancel: only QUEUED or PROCESSING batches can be stopped. The worker
    // has no in-process kill switch for an in-flight tick — for truly stuck
    // workers an operator must restart the analytics container, after which
    // the stuck-batch sweeper will see this row is already FAILED.
    const tenantId = await this.resolveTenantId(user);
    const rawResult = await this.db.query(
      `
      update import_batches
      set import_status = 'FAILED',
          notes = coalesce(notes, '') || ' [cancelled by user]',
          completed_at = now(),
          error_count = greatest(error_count, 1)
      where id = $1
        and tenant_id = $2
        and import_status in ('QUEUED', 'PROCESSING')
      returning id
      `,
      [importId, tenantId]
    );
    const rows = this.normalizeReturnedRows(rawResult);
    if (!rows.length) {
      throw Object.assign(
        new Error('Import not found or already in a terminal state'),
        { statusCode: 404 }
      );
    }
    return { cancelled: true };
  }

  async sweepStuckImports(timeoutMinutes: number): Promise<number> {
    // Mark any PROCESSING batch older than the timeout as FAILED so the UI
    // stops polling forever and the user can retry.
    const rawResult = await this.db.query(
      `
      update import_batches
      set import_status = 'FAILED',
          notes = coalesce(notes, '') || ' [auto-failed: stuck > ' || $1 || ' min]',
          completed_at = now(),
          error_count = greatest(error_count, 1)
      where import_status = 'PROCESSING'
        and started_at is not null
        and started_at < now() - ($1 || ' minutes')::interval
      returning id
      `,
      [timeoutMinutes]
    );
    const rows = this.normalizeReturnedRows(rawResult);
    if (rows.length) {
      console.log(`[import-sweeper] auto-failed ${rows.length} stuck batch(es)`);
    }
    return rows.length;
  }

  private async latestSnapshotDate(tenantId: number): Promise<string | null> {
    const rows = await this.db.query(`select max(snapshot_date) as latest_date from entity_metric_snapshots where tenant_id = $1`, [tenantId]);
    return toDateOnly(rows[0]?.latest_date) || null;
  }

  private async resolveCompareSnapshotDate(tenantId: number, periodLabel?: string, snapshotDate?: string): Promise<string | null> {
    if (snapshotDate) {
      return toDateOnly(snapshotDate) || snapshotDate;
    }

    const latestDate = await this.latestSnapshotDate(tenantId);
    if (!latestDate) {
      return null;
    }

    const timeRange = normalizeCompareTimeRange(periodLabel);
    const lookbackDays: Record<string, number> = {
      today: 0,
      mtd: 0,
      last7d: 6,
      last30d: 29,
      last90d: 89
    };
    const offset = lookbackDays[timeRange] ?? 0;
    if (offset === 0) {
      return latestDate;
    }

    const cutoffDate = shiftDate(latestDate, -offset);
    const rows = await this.db.query(
      `select max(snapshot_date) as snapshot_date from entity_metric_snapshots where tenant_id = $1 and snapshot_date <= $2::date`,
      [tenantId, cutoffDate]
    );
    return toDateOnly(rows[0]?.snapshot_date) || latestDate;
  }

  private async resolveInsightDateWindow(
    tenantId: number,
    timeRange?: string
  ): Promise<{ startDate: string; endDate: string } | null> {
    if (!timeRange) {
      return null;
    }

    const latestDate = await this.latestSnapshotDate(tenantId);
    if (!latestDate) {
      return null;
    }

    const normalizedTimeRange = normalizeCompareTimeRange(timeRange);
    const lookbackDays: Record<string, number> = {
      today: 0,
      mtd: 0,
      last7d: 6,
      last30d: 29,
      last90d: 89
    };

    if (normalizedTimeRange === 'mtd') {
      return {
        startDate: startOfMonth(latestDate),
        endDate: latestDate
      };
    }

    const offset = lookbackDays[normalizedTimeRange] ?? 0;
    return {
      startDate: shiftDate(latestDate, -offset),
      endDate: latestDate
    };
  }

  private formatBriefingCurrency(value: number): string {
    return `₹${Math.round(Number(value || 0)).toLocaleString('en-IN')}`;
  }

  private previousComparableMonthDate(value: string): string {
    const { year, month, day } = getDateParts(value);
    const previousMonth = month === 1 ? 12 : month - 1;
    const previousYear = month === 1 ? year - 1 : year;
    const previousMonthDays = new Date(Date.UTC(previousYear, previousMonth, 0)).getUTCDate();
    return formatDateParts(previousYear, previousMonth, Math.min(day, previousMonthDays));
  }

  private async resolveLatestSnapshotOnOrBefore(tenantId: number, value: string): Promise<string | null> {
    const rows = await this.db.query(
      `select max(snapshot_date) as snapshot_date from entity_metric_snapshots where tenant_id = $1 and snapshot_date <= $2::date`,
      [tenantId, value]
    );
    return toDateOnly(rows[0]?.snapshot_date) || null;
  }

  private buildExploreDrillPath(entityType?: string | null): string {
    const normalized = String(entityType || '').toLowerCase();
    if (['salesman', 'retailer', 'sku', 'distributor', 'beat'].includes(normalized)) {
      return `/explore?entity=${normalized}`;
    }
    return '/summary';
  }

  private buildSignalSourceKey(entityType: string, entityId: string, signalKey: string): string {
    return `${String(entityType || '').toLowerCase()}:${String(entityId || '')}:${String(signalKey || '').toLowerCase()}`;
  }

  private getFiscalQuarterLabel(value: string): string {
    const { year, month } = getDateParts(value);
    const fiscalQuarter = Math.floor((((month - 4 + 12) % 12) / 3)) + 1;
    const fiscalYear = month >= 4 ? year + 1 : year;
    return `Q${fiscalQuarter} FY${String(fiscalYear).slice(-2)}`;
  }

  private formatBriefingDateLabel(value: string): string {
    return new Date(`${value}T00:00:00.000Z`).toLocaleDateString('en-IN', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC'
    });
  }

  private formatExplorePeriodLabel(value: string): string {
    return new Date(`${value}T00:00:00.000Z`).toLocaleDateString('en-IN', {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC'
    });
  }

  private summarizeDeliverySummary(input: any, fallbackTargetCount = 0): string {
    const summary = input && typeof input === 'object' ? input : {};
    const delivered = Number(summary.delivered || 0);
    const responded = Number(summary.responded || 0);
    const targetCount = Number(summary.targetCount || fallbackTargetCount || 0);
    if (targetCount > 0) {
      return `${delivered}/${targetCount} delivered${responded > 0 ? ` · ${responded} responded` : ''}`;
    }
    return delivered > 0 || responded > 0 ? `${delivered} delivered${responded > 0 ? ` · ${responded} responded` : ''}` : 'Not sent yet';
  }

  private mapActionTypeLabel(value: string): string {
    const normalized = String(value || '').toLowerCase();
    if (normalized === 'goal_push') return 'Goal Push';
    if (normalized === 'collection') return 'Collection Drive';
    if (normalized === 'scheme') return 'Trade Scheme';
    if (normalized === 'announcement') return 'Announcement';
    return 'Nudge';
  }

  private async fetchActionDashboardInternal(tenantId: number) {
    const statsRows = await this.db.query(
      `
      select status, count(*)::int as count
      from actions
      where tenant_id = $1
      group by status
      `,
      [tenantId]
    );
    const recentRows = await this.db.query(
      `
      select
        a.*,
        count(distinct at.id)::int as target_count
      from actions a
      left join action_targets at on at.action_id = a.id
      where a.tenant_id = $1
      group by a.id
      order by a.updated_at desc
      limit 6
      `,
      [tenantId]
    );

    const counts: Record<string, number> = {};
    for (const row of statsRows as any[]) {
      counts[String(row.status)] = Number(row.count || 0);
    }

    return {
      runningCount: counts.active || 0,
      draftCount: counts.draft || 0,
      totalCount: Object.values(counts).reduce((sum: number, value: number) => sum + Number(value || 0), 0),
      items: recentRows.map((row: any) => ({
        id: Number(row.id),
        title: row.title,
        type: this.mapActionTypeLabel(String(row.type || '')),
        rawType: row.type,
        status: row.status,
        sourceKind: row.source_kind,
        sourceEntityType: row.source_entity_type,
        sourceEntityId: row.source_entity_id,
        sourceEntityName: row.source_entity_name,
        audienceType: row.audience_type,
        targetCount: Number(row.target_count || 0),
        deliverySummary: this.summarizeDeliverySummary(row.delivery_summary, Number(row.target_count || 0)),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    };
  }

  private async fetchActionLogInternal(tenantId: number) {
    const entries = await this.db.query(
      `
      select
        ae.id,
        ae.event_type,
        ae.label,
        ae.detail,
        ae.created_at,
        a.id as action_id,
        a.title as action_title,
        a.type as action_type
      from action_events ae
      join actions a on a.id = ae.action_id
      where ae.tenant_id = $1
      order by ae.created_at desc
      limit 60
      `,
      [tenantId]
    );
    const tasks = await this.db.query(
      `
      select *
      from action_tasks
      where tenant_id = $1
      order by created_at desc
      limit 100
      `,
      [tenantId]
    );
    const today = getCurrentISTDate();
    const toDate = (value: string) => formatISTDate(new Date(value));
    const todayEntries = entries.filter((entry: any) => toDate(String(entry.created_at)) === today);
    const olderEntries = entries.filter((entry: any) => toDate(String(entry.created_at)) !== today);
    const openTasks = tasks.filter((task: any) => task.status === 'open');
    const doneTasks = tasks.filter((task: any) => task.status === 'done');

    return {
      todayCount: todayEntries.length,
      openTaskCount: openTasks.length,
      today: todayEntries.map((entry: any) => ({
        id: Number(entry.id),
        actionId: Number(entry.action_id),
        timestamp: entry.created_at,
        type: entry.event_type,
        label: entry.label,
        detail: entry.detail || entry.action_title || null
      })),
      earlier: olderEntries.map((entry: any) => ({
        id: Number(entry.id),
        actionId: Number(entry.action_id),
        timestamp: entry.created_at,
        type: entry.event_type,
        label: entry.label,
        detail: entry.detail || entry.action_title || null
      })),
      tasks: {
        open: openTasks.map((task: any) => ({
          id: Number(task.id),
          actionId: task.action_id ? Number(task.action_id) : null,
          assignee: task.assignee,
          instruction: task.instruction,
          deadline: task.deadline,
          entityType: task.entity_type,
          entityId: task.entity_id,
          entityName: task.entity_name,
          status: task.status,
          createdAt: task.created_at
        })),
        done: doneTasks.map((task: any) => ({
          id: Number(task.id),
          actionId: task.action_id ? Number(task.action_id) : null,
          assignee: task.assignee,
          instruction: task.instruction,
          deadline: task.deadline,
          entityType: task.entity_type,
          entityId: task.entity_id,
          entityName: task.entity_name,
          status: task.status,
          createdAt: task.created_at
        }))
      }
    };
  }

  async getObserveSummary(user?: IAuthUser) {
    const tenantId = await this.resolveTenantId(user);
    const latestDate = await this.latestSnapshotDate(tenantId);
    if (!latestDate) {
      return {
        period: {
          label: 'MTD',
          periodLabel: '-',
          quarter: '-',
          quarterLabel: '-',
          dateLabel: '-',
          dayElapsed: 0,
          daysInPeriod: 0
        },
        summarySection: { metricCards: [], goals: [], periodIntelligence: [], entityPulseCards: [] },
        intelligence: [],
        briefing: {
          attention: [],
          team: {
            totalSalesmen: 0,
            onTarget: 0,
            atRisk: 0,
            behind: 0,
            topPerformer: { name: '-', revenue: this.formatBriefingCurrency(0), pct: 0 },
            bottomPerformer: { name: '-', revenue: this.formatBriefingCurrency(0), pct: 0 }
          },
          whatChanged: {
            period: { current: '-', previous: '-' },
            improvingCount: 0,
            decliningCount: 0,
            flatCount: 0,
            highlights: [],
            bigMovers: []
          },
          retailerHealth: {
            totalRetailers: 0,
            tiers: [
              { tier: 'platinum', label: 'Platinum', count: 0, dormantCount: 0 },
              { tier: 'gold', label: 'Gold', count: 0, dormantCount: 0 },
              { tier: 'silver', label: 'Silver', count: 0, dormantCount: 0 },
              { tier: 'bronze', label: 'Bronze', count: 0, dormantCount: 0 }
            ]
          },
          goalsPreview: { count: 0, items: [] },
          activeActions: { runningCount: 0, draftCount: 0, totalCount: 0, items: [] },
          anomalies: { criticalCount: 0, warningCount: 0, totalCount: 0, items: [] }
        }
      };
    }

    const actionDashboard = await this.fetchActionDashboardInternal(tenantId);

    const summaryRows = await this.db.query(
      `
      select metric_key, metric_value
      from entity_metric_snapshots
      where tenant_id = $1 and entity_type = 'summary' and entity_id = 'summary' and snapshot_date = $2::date
      `,
      [tenantId, latestDate]
    );
    const summaryMap: Record<string, number> = {};
    for (const row of summaryRows) {
      summaryMap[row.metric_key] = Number(row.metric_value || 0);
    }

    const signals = await this.db.query(
      `
      select id, signal_key, severity, headline, description, entity_type, entity_id, entity_name, detected_at
      from entity_signals
      where tenant_id = $1
      order by detected_at desc
      limit 200
      `,
      [tenantId]
    );

    const pulseRows = await this.db.query(
      `
      select entity_type, count(distinct entity_id)::int as count
      from entity_metric_snapshots
      where tenant_id = $1 and snapshot_date = $2::date and entity_type in ('salesman','retailer','beat','sku','distributor')
      group by entity_type
      `,
      [tenantId, latestDate]
    );
    const pulseMap: Record<string, number> = {};
    for (const row of pulseRows) {
      pulseMap[row.entity_type] = Number(row.count || 0);
    }

    const signalKeyIncludes = (signal: any, patterns: string[]) =>
      patterns.some((pattern) => String(signal?.signal_key || '').includes(pattern));

    const countSignals = (patterns: string[], severity?: string) =>
      signals.filter((signal: any) => {
        if (severity && signal?.severity !== severity) {
          return false;
        }
        return signalKeyIncludes(signal, patterns);
      }).length;

    const getSignalActionLabel = (signalKey: string) => {
      if (signalKey.includes('coverage') || signalKey.includes('salesman')) {
        return 'View salesman';
      }
      if (signalKey.includes('retailer') || signalKey.includes('outstanding')) {
        return 'View retailers';
      }
      if (signalKey.includes('sku')) {
        return 'View SKU';
      }
      if (signalKey.includes('distributor') || signalKey.includes('damage') || signalKey.includes('fulfilment')) {
        return 'View distributor';
      }
      if (signalKey.includes('beat')) {
        return 'View beat';
      }
      return 'Review';
    };

    const targets = await this.listTargets(user);
    const goals = targets.targets.slice(0, 4).map((target: any) => ({
      id: target.id,
      name: `${target.metric} Target`,
      baseline: Number(target.baselineValue || 0),
      current: Number(target.actualValue || 0),
      target: Number(target.targetValue || 0),
      value: Math.min(100, Number(target.attainmentPct || 0)),
      status: Number(target.attainmentPct || 0) >= 100 ? 'On Track' : Number(target.attainmentPct || 0) >= 80 ? 'At Risk' : 'Behind',
      statusColor: Number(target.attainmentPct || 0) >= 100 ? 'green' : Number(target.attainmentPct || 0) >= 80 ? 'orange' : 'red',
      accent: '#4463ea',
      daysLeft: target.periodLabel || ''
    }));

    const previousComparableDate = this.previousComparableMonthDate(latestDate);
    const previousSnapshotDate = await this.resolveLatestSnapshotOnOrBefore(tenantId, previousComparableDate);
    const comparisonMetrics = [
      'revenue_mtd',
      'collection_mtd',
      'coverage_pct',
      'beat_adherence_pct',
      'aov',
      'outstanding',
      'dormancy_days',
      'units_mtd',
      'penetration_pct',
      'orders_mtd',
      'realization_pct'
    ];
    const comparisonEntityTypes = ['salesman', 'retailer', 'sku', 'distributor', 'beat'];

    const currentComparisonRows = await this.db.query(
      `
      select entity_type, entity_id, max(entity_name) as entity_name, metric_key, max(metric_value) as metric_value
      from entity_metric_snapshots
      where tenant_id = $1
        and snapshot_date = $2::date
        and entity_type = any($3::text[])
        and metric_key = any($4::text[])
      group by entity_type, entity_id, metric_key
      `,
      [tenantId, latestDate, comparisonEntityTypes, comparisonMetrics]
    );

    const previousComparisonRows = previousSnapshotDate
      ? await this.db.query(
          `
          select entity_type, entity_id, max(entity_name) as entity_name, metric_key, max(metric_value) as metric_value
          from entity_metric_snapshots
          where tenant_id = $1
            and snapshot_date = $2::date
            and entity_type = any($3::text[])
            and metric_key = any($4::text[])
          group by entity_type, entity_id, metric_key
          `,
          [tenantId, previousSnapshotDate, comparisonEntityTypes, comparisonMetrics]
        )
      : [];

    const buildEntityMetricMap = (rows: any[]) => {
      const map = new Map<string, { entityType: string; entityId: string; entityName: string; metrics: Record<string, number> }>();
      for (const row of rows) {
        const key = `${row.entity_type}:${row.entity_id}`;
        const existing =
          map.get(key) ||
          {
            entityType: String(row.entity_type),
            entityId: String(row.entity_id),
            entityName: String(row.entity_name || row.entity_id),
            metrics: {}
          };
        existing.metrics[String(row.metric_key)] = Number(row.metric_value || 0);
        map.set(key, existing);
      }
      return map;
    };

    const currentMetricMap = buildEntityMetricMap(currentComparisonRows);
    const previousMetricMap = buildEntityMetricMap(previousComparisonRows);

    const salesmanSnapshot = Array.from(currentMetricMap.values()).filter((item) => item.entityType === 'salesman');
    const totalSalesmen = salesmanSnapshot.length;
    const averageSalesmanRevenue =
      totalSalesmen > 0
        ? salesmanSnapshot.reduce((sum, item) => sum + Number(item.metrics.revenue_mtd || 0), 0) / totalSalesmen
        : 0;
    const targetRevenue = averageSalesmanRevenue * 1.1;
    let onTarget = 0;
    let atRisk = 0;
    let behind = 0;
    const rankedSalesmen = [...salesmanSnapshot].sort(
      (left, right) => Number(right.metrics.revenue_mtd || 0) - Number(left.metrics.revenue_mtd || 0)
    );
    for (const item of salesmanSnapshot) {
      const pct = targetRevenue > 0 ? (Number(item.metrics.revenue_mtd || 0) * 100) / targetRevenue : 0;
      if (pct >= 90) {
        onTarget += 1;
      } else if (pct >= 70) {
        atRisk += 1;
      } else {
        behind += 1;
      }
    }
    const topSalesman = rankedSalesmen[0];
    const bottomSalesman = rankedSalesmen[rankedSalesmen.length - 1];

    const tierMeta: Record<string, { label: string; minAov: number; maxAov?: number }> = {
      platinum: { label: 'Platinum', minAov: 12000 },
      gold: { label: 'Gold', minAov: 8000 },
      silver: { label: 'Silver', minAov: 5000 },
      bronze: { label: 'Bronze', minAov: 0 }
    };
    const retailerHealth = {
      totalRetailers: 0,
      tiers: [
        { tier: 'platinum', label: tierMeta.platinum.label, count: 0, dormantCount: 0 },
        { tier: 'gold', label: tierMeta.gold.label, count: 0, dormantCount: 0 },
        { tier: 'silver', label: tierMeta.silver.label, count: 0, dormantCount: 0 },
        { tier: 'bronze', label: tierMeta.bronze.label, count: 0, dormantCount: 0 }
      ]
    };
    for (const item of Array.from(currentMetricMap.values()).filter((entry) => entry.entityType === 'retailer')) {
      const aov = Number(item.metrics.aov || 0);
      const dormancy = Number(item.metrics.dormancy_days || 0);
      const tier =
        aov >= tierMeta.platinum.minAov
          ? 'platinum'
          : aov >= tierMeta.gold.minAov
            ? 'gold'
            : aov >= tierMeta.silver.minAov
              ? 'silver'
              : 'bronze';
      const summaryTier = retailerHealth.tiers.find((entry) => entry.tier === tier);
      retailerHealth.totalRetailers += 1;
      if (summaryTier) {
        summaryTier.count += 1;
        if (dormancy > 14) {
          summaryTier.dormantCount += 1;
        }
      }
    }
    const totalRetailerOutstanding = Array.from(currentMetricMap.values())
      .filter((entry) => entry.entityType === 'retailer')
      .reduce((sum, entry) => sum + Number(entry.metrics.outstanding || 0), 0);

    const metricLabels: Record<string, string> = {
      revenue_mtd: 'Revenue',
      collection_mtd: 'Collection',
      coverage_pct: 'Coverage',
      beat_adherence_pct: 'Adherence',
      aov: 'AOV',
      outstanding: 'Outstanding',
      units_mtd: 'Units',
      penetration_pct: 'Penetration',
      orders_mtd: 'Orders',
      realization_pct: 'Realization'
    };
    const metricFormatters: Record<string, (value: number) => string> = {
      revenue_mtd: (value) => this.formatBriefingCurrency(value),
      collection_mtd: (value) => this.formatBriefingCurrency(value),
      coverage_pct: (value) => `${Number(value || 0).toFixed(1)}%`,
      beat_adherence_pct: (value) => `${Number(value || 0).toFixed(1)}%`,
      aov: (value) => this.formatBriefingCurrency(value),
      outstanding: (value) => this.formatBriefingCurrency(value),
      units_mtd: (value) => Math.round(Number(value || 0)).toLocaleString('en-IN'),
      penetration_pct: (value) => `${Number(value || 0).toFixed(1)}%`,
      orders_mtd: (value) => Math.round(Number(value || 0)).toLocaleString('en-IN'),
      realization_pct: (value) => `${Number(value || 0).toFixed(1)}%`
    };
    const deltaMetricsByEntityType: Record<string, string[]> = {
      salesman: ['revenue_mtd', 'collection_mtd', 'coverage_pct', 'beat_adherence_pct'],
      retailer: ['aov', 'outstanding'],
      sku: ['revenue_mtd', 'units_mtd', 'penetration_pct'],
      distributor: ['revenue_mtd'],
      beat: ['revenue_mtd', 'realization_pct']
    };
    const whatChangedEntries: Array<Record<string, any>> = [];
    for (const currentEntry of Array.from(currentMetricMap.values())) {
      const previousEntry = previousMetricMap.get(`${currentEntry.entityType}:${currentEntry.entityId}`);
      if (!previousEntry) {
        continue;
      }
      const metrics = deltaMetricsByEntityType[currentEntry.entityType] || [];
      for (const metricKey of metrics) {
        const currentValue = Number(currentEntry.metrics[metricKey] || 0);
        const previousValue = Number(previousEntry.metrics[metricKey] || 0);
        const delta = currentValue - previousValue;
        const deltaPercent = previousValue !== 0 ? (delta * 100) / previousValue : currentValue !== 0 ? 100 : 0;
        const roundedDeltaPercent = Math.round(deltaPercent * 10) / 10;
        const direction = Math.abs(roundedDeltaPercent) < 2 ? 'flat' : delta > 0 ? 'up' : 'down';
        const absPct = Math.abs(roundedDeltaPercent);
        const significance = absPct >= 15 ? 'high' : absPct >= 8 ? 'medium' : 'low';
        whatChangedEntries.push({
          id: `${currentEntry.entityType}:${currentEntry.entityId}:${metricKey}`,
          entityType: currentEntry.entityType,
          entityId: currentEntry.entityId,
          name: currentEntry.entityName,
          metric: metricKey,
          metricLabel: metricLabels[metricKey] || metricKey,
          currentValue,
          previousValue,
          formattedCurrent: (metricFormatters[metricKey] || ((value) => String(value)))(currentValue),
          formattedPrevious: (metricFormatters[metricKey] || ((value) => String(value)))(previousValue),
          direction,
          significance,
          deltaPercent: roundedDeltaPercent,
          drillPath: this.buildExploreDrillPath(currentEntry.entityType)
        });
      }
    }
    const significanceRank: Record<string, number> = { high: 3, medium: 2, low: 1 };
    const sortedChanges = whatChangedEntries
      .filter((entry) => entry.direction !== 'flat')
      .sort((left, right) => {
        const significanceDiff = significanceRank[right.significance] - significanceRank[left.significance];
        if (significanceDiff !== 0) {
          return significanceDiff;
        }
        return Math.abs(right.deltaPercent) - Math.abs(left.deltaPercent);
      });
    const salesmanRevenueChanges = sortedChanges.filter(
      (entry) => entry.entityType === 'salesman' && entry.metric === 'revenue_mtd'
    );
    const skuRevenueChanges = sortedChanges.filter((entry) => entry.entityType === 'sku' && entry.metric === 'revenue_mtd');
    const topImprover = salesmanRevenueChanges.find((entry) => entry.direction === 'up');
    const topDecliner = salesmanRevenueChanges.find((entry) => entry.direction === 'down');
    const topSkuUp = skuRevenueChanges.find((entry) => entry.direction === 'up');
    const topSkuDown = skuRevenueChanges.find((entry) => entry.direction === 'down');
    const changeHighlights = [
      topImprover
        ? {
            id: `salesman-up-${topImprover.entityId}`,
            text: `${topImprover.name} revenue up ${Math.abs(topImprover.deltaPercent)}% vs last month (${topImprover.formattedPrevious} -> ${topImprover.formattedCurrent})`,
            severity: 'positive',
            drillPath: topImprover.drillPath
          }
        : null,
      topDecliner
        ? {
            id: `salesman-down-${topDecliner.entityId}`,
            text: `${topDecliner.name} revenue down ${Math.abs(topDecliner.deltaPercent)}% vs last month — needs attention`,
            severity: 'negative',
            drillPath: topDecliner.drillPath
          }
        : null,
      topSkuUp
        ? {
            id: `sku-up-${topSkuUp.entityId}`,
            text: `${topSkuUp.name} picking up momentum: +${Math.abs(topSkuUp.deltaPercent)}% MoM`,
            severity: 'positive',
            drillPath: topSkuUp.drillPath
          }
        : null,
      topSkuDown
        ? {
            id: `sku-down-${topSkuDown.entityId}`,
            text: `${topSkuDown.name} declining ${Math.abs(topSkuDown.deltaPercent)}% MoM — investigate distribution`,
            severity: 'negative',
            drillPath: topSkuDown.drillPath
          }
        : null
    ].filter(Boolean);

    const anomalyItems = signals.map((signal: any) => ({
      id: signal.id,
      key: signal.signal_key,
      sourceKey: signal.source_key || this.buildSignalSourceKey(String(signal.entity_type), String(signal.entity_id || ''), String(signal.signal_key)),
      actionState: signal.action_state || 'new',
      severity: signal.severity,
      entityType: signal.entity_type,
      entityId: signal.entity_id ? String(signal.entity_id) : null,
      entityName: signal.entity_name || null,
      label: signal.headline,
      detail: signal.description || '',
      drillPath: this.buildExploreDrillPath(signal.entity_type)
    }));
    const attentionItems = anomalyItems.filter((item: any) => item.severity === 'critical' || item.severity === 'warning').slice(0, 3);
    const latestDateParts = getDateParts(latestDate);

    return {
      period: {
        label: 'MTD',
        periodLabel: new Date(`${latestDate}T00:00:00.000Z`).toLocaleDateString('en-IN', {
          month: 'short',
          year: 'numeric',
          timeZone: 'UTC'
        }),
        quarterLabel: this.getFiscalQuarterLabel(latestDate),
        dateLabel: this.formatBriefingDateLabel(latestDate),
        dayElapsed: latestDateParts.day,
        daysInPeriod: latestDateParts.daysInMonth,
        quarter: this.getFiscalQuarterLabel(latestDate)
      },
      summarySection: {
        metricCards: [
          {
            key: 'revenue',
            title: 'Revenue MTD',
            value: this.formatBriefingCurrency(Number(summaryMap.gmv || 0)),
            subtitle: 'Gross merchandise value',
            note: `${Number(summaryMap.gmv || 0).toFixed(0)}`,
            accent: '#4463ea'
          },
          {
            key: 'collection',
            title: 'Collection',
            value: this.formatBriefingCurrency(Number(summaryMap.collections || 0)),
            subtitle: 'Cashflow realized',
            note: `${Number(summaryMap.collections || 0).toFixed(0)}`,
            accent: '#0f9d58'
          },
          {
            key: 'coverage',
            title: 'Coverage',
            value: `${Number(summaryMap.coverage_pct || 0).toFixed(1)}%`,
            subtitle: 'Billed outlet coverage',
            note: `${Number(summaryMap.coverage_pct || 0).toFixed(1)}%`,
            accent: '#f59e0b'
          },
          {
            key: 'outstanding',
            title: 'Outstanding',
            value: this.formatBriefingCurrency(totalRetailerOutstanding),
            subtitle: `Across ${retailerHealth.totalRetailers} retailers`,
            note: `${Math.round(totalRetailerOutstanding).toLocaleString('en-IN')}`,
            accent: '#d97706'
          }
        ],
        goals,
        periodIntelligence: signals.map((s: any) => ({
          key: s.signal_key,
          type: s.severity === 'critical' ? 'negative' : 'positive',
          label: s.headline,
          detail: s.description || '',
          action: getSignalActionLabel(String(s.signal_key || ''))
        })),
        entityPulseCards: [
          {
            key: 'salesman',
            title: 'Salesman',
            labelOne: 'Tracked',
            valueOne: String(pulseMap.salesman || 0),
            labelTwo: 'Signals',
            valueTwo: String(countSignals(['coverage', 'salesman', 'beat_adherence', 'collection_ratio', 'zero_billing_days'])),
            labelThree: 'Critical',
            valueThree: String(countSignals(['coverage', 'salesman', 'beat_adherence', 'collection_ratio', 'zero_billing_days'], 'critical')),
            indicator: countSignals(['coverage', 'salesman', 'beat_adherence', 'collection_ratio', 'zero_billing_days'], 'critical') > 0 ? 'critical' : 'warning',
            footnote: `${pulseMap.salesman || 0} salesmen available in the latest snapshot`
          },
          {
            key: 'retailer',
            title: 'Retailer',
            labelOne: 'Tracked',
            valueOne: String(pulseMap.retailer || 0),
            labelTwo: 'Signals',
            valueTwo: String(countSignals(['retailer', 'outstanding', 'aov', 'days_since_last_order'])),
            labelThree: 'Critical',
            valueThree: String(countSignals(['retailer', 'outstanding', 'aov', 'days_since_last_order'], 'critical')),
            indicator: countSignals(['retailer', 'outstanding', 'aov', 'days_since_last_order'], 'critical') > 0 ? 'critical' : 'warning',
            footnote: `${pulseMap.retailer || 0} retailers available in the latest snapshot`
          },
          {
            key: 'beat',
            title: 'Beat',
            labelOne: 'Tracked',
            valueOne: String(pulseMap.beat || 0),
            labelTwo: 'Signals',
            valueTwo: String(countSignals(['beat'])),
            labelThree: 'Critical',
            valueThree: String(countSignals(['beat'], 'critical')),
            indicator: countSignals(['beat'], 'critical') > 0 ? 'critical' : 'warning',
            footnote: `${pulseMap.beat || 0} beats available in the latest snapshot`
          },
          {
            key: 'sku',
            title: 'SKU',
            labelOne: 'Tracked',
            valueOne: String(pulseMap.sku || 0),
            labelTwo: 'Signals',
            valueTwo: String(countSignals(['sku'])),
            labelThree: 'Critical',
            valueThree: String(countSignals(['sku'], 'critical')),
            indicator: countSignals(['sku'], 'critical') > 0 ? 'critical' : 'warning',
            footnote: `${pulseMap.sku || 0} SKUs available in the latest snapshot`
          },
          {
            key: 'distributor',
            title: 'Distributor',
            labelOne: 'Tracked',
            valueOne: String(pulseMap.distributor || 0),
            labelTwo: 'Signals',
            valueTwo: String(countSignals(['distributor', 'damage', 'fulfilment'])),
            labelThree: 'Critical',
            valueThree: String(countSignals(['distributor', 'damage', 'fulfilment'], 'critical')),
            indicator: countSignals(['distributor', 'damage', 'fulfilment'], 'critical') > 0 ? 'critical' : 'warning',
            footnote: `${pulseMap.distributor || 0} distributors available in the latest snapshot`
          }
        ]
      },
      intelligence: signals,
      briefing: {
        attention: attentionItems,
        team: {
          totalSalesmen,
          onTarget,
          atRisk,
          behind,
          topPerformer: {
            name: topSalesman?.entityName || '-',
            revenue: this.formatBriefingCurrency(Number(topSalesman?.metrics?.revenue_mtd || 0)),
            pct:
              targetRevenue > 0
                ? Math.round((Number(topSalesman?.metrics?.revenue_mtd || 0) * 100) / targetRevenue)
                : 0
          },
          bottomPerformer: {
            name: bottomSalesman?.entityName || '-',
            revenue: this.formatBriefingCurrency(Number(bottomSalesman?.metrics?.revenue_mtd || 0)),
            pct:
              targetRevenue > 0
                ? Math.round((Number(bottomSalesman?.metrics?.revenue_mtd || 0) * 100) / targetRevenue)
                : 0
          }
        },
        whatChanged: {
          period: {
            current: `${new Date(`${latestDate}T00:00:00.000Z`).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })}`,
            previous: previousSnapshotDate
              ? `${new Date(`${previousSnapshotDate}T00:00:00.000Z`).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })}`
              : '-'
          },
          improvingCount: whatChangedEntries.filter((entry) => entry.direction === 'up').length,
          decliningCount: whatChangedEntries.filter((entry) => entry.direction === 'down').length,
          flatCount: whatChangedEntries.filter((entry) => entry.direction === 'flat').length,
          highlights: changeHighlights,
          bigMovers: sortedChanges.slice(0, 6).map((entry) => ({
            id: entry.id,
            entityType: entry.entityType,
            entityId: entry.entityId,
            name: entry.name,
            metric: entry.metric,
            metricLabel: entry.metricLabel,
            direction: entry.direction,
            deltaPercent: entry.deltaPercent,
            drillPath: entry.drillPath
          }))
        },
        retailerHealth,
        goalsPreview: {
          count: goals.length,
          items: goals.slice(0, 3).map((goal: any) => ({
            id: goal.id,
            name: goal.name,
            progressPercent: Number(goal.value || 0),
            status: goal.status,
            statusColor: goal.statusColor
          }))
        },
        activeActions: actionDashboard,
        anomalies: {
          criticalCount: anomalyItems.filter((item: any) => item.severity === 'critical').length,
          warningCount: anomalyItems.filter((item: any) => item.severity === 'warning').length,
          totalCount: anomalyItems.length,
          items: anomalyItems
        }
      }
    };
  }

  async listObserveEntity(entityType: string, user?: IAuthUser, query?: { limit?: number; page?: number; timeRange?: string }) {
    const tenantId = await this.resolveTenantId(user);
    const snapshotDate = await this.resolveCompareSnapshotDate(tenantId, query?.timeRange);
    if (!snapshotDate) {
      return { data: [], meta: { page: 1, limit: 0, total: 0, totalPages: 0 } };
    }

    const dateWindow = (await this.resolveInsightDateWindow(tenantId, query?.timeRange)) || {
      startDate: startOfMonth(snapshotDate),
      endDate: snapshotDate
    };
    const previousSnapshotDate = await this.resolveLatestSnapshotOnOrBefore(
      tenantId,
      this.previousComparableMonthDate(snapshotDate)
    );

    let mapped: any[] = [];

    if (entityType === 'salesman') {
      const rows = await this.db.query(
        `
        with current_metrics as (
          select
            entity_id,
            max(case when metric_key = 'revenue_mtd' then metric_value end) as revenue_mtd,
            max(case when metric_key = 'collection_mtd' then metric_value end) as collection_mtd,
            max(case when metric_key = 'orders_mtd' then metric_value end) as orders_mtd,
            max(case when metric_key = 'coverage_pct' then metric_value end) as coverage_pct,
            max(case when metric_key = 'beat_adherence_pct' then metric_value end) as beat_adherence_pct,
            max(case when metric_key = 'outstanding' then metric_value end) as outstanding
          from entity_metric_snapshots
          where tenant_id = $1 and entity_type = 'salesman' and snapshot_date = $2::date
          group by entity_id
        ),
        previous_metrics as (
          select
            entity_id,
            max(case when metric_key = 'revenue_mtd' then metric_value end) as previous_revenue_mtd,
            max(case when metric_key = 'collection_mtd' then metric_value end) as previous_collection_mtd
          from entity_metric_snapshots
          where tenant_id = $1 and entity_type = 'salesman' and snapshot_date = $3::date
          group by entity_id
        ),
        current_orders as (
          select
            salesman_id,
            count(distinct outlet_id) as outlets_visited,
            max(coalesce(order_punched_at, order_sale_date::timestamp)) as last_active_at
          from sales_orders
          where tenant_id = $1
            and order_sale_date between $4::date and $5::date
            and salesman_id is not null
          group by salesman_id
        ),
        current_outlets as (
          select salesman_id, count(distinct outlet_id) as outlets_total
          from tenant_outlets
          where tenant_id = $1 and active = true and salesman_id is not null
          group by salesman_id
        ),
        route_candidates as (
          select *
          from (
            select
              to2.salesman_id,
              coalesce(b.beat_name, '-') as beat_name,
              row_number() over (
                partition by to2.salesman_id
                order by count(*) desc, coalesce(b.beat_name, '-') asc
              ) as rn
            from tenant_outlets to2
            left join beat_outlets bo
              on bo.tenant_id = to2.tenant_id
             and bo.outlet_id = to2.outlet_id
             and bo.active = true
            left join beats b on b.id = bo.beat_id
            where to2.tenant_id = $1 and to2.active = true and to2.salesman_id is not null
            group by to2.salesman_id, coalesce(b.beat_name, '-')
          ) ranked
          where rn = 1
        ),
        manager_matches as (
          select *
          from (
            select
              s.id as salesman_id,
              mgr.full_name as manager_name,
              row_number() over (
                partition by s.id
                order by
                  case when s.employee_code is not null and p.person_code = s.employee_code then 0 else 1 end,
                  mgr.full_name asc nulls last
              ) as rn
            from salesmen s
            left join people p
              on p.tenant_id = s.tenant_id
             and p.active = true
             and (
               (s.employee_code is not null and p.person_code = s.employee_code)
               or lower(p.full_name) = lower(s.salesman_name)
             )
            left join people mgr on mgr.id = p.manager_person_id
            where s.tenant_id = $1 and s.active = true
          ) ranked
          where rn = 1
        )
        select
          s.id::text as salesman_id,
          s.salesman_name,
          coalesce(s.zone, d.zone, '-') as zone,
          coalesce(s.region, d.region, '-') as region,
          coalesce(s.area, d.area, '-') as area,
          coalesce(cm.revenue_mtd, 0) as revenue_mtd,
          coalesce(cm.collection_mtd, 0) as collection_mtd,
          coalesce(cm.orders_mtd, 0) as orders_mtd,
          coalesce(cm.coverage_pct, 0) as coverage_pct,
          coalesce(cm.beat_adherence_pct, 0) as beat_adherence_pct,
          coalesce(cm.outstanding, 0) as outstanding,
          coalesce(pm.previous_revenue_mtd, 0) as previous_revenue_mtd,
          coalesce(pm.previous_collection_mtd, 0) as previous_collection_mtd,
          coalesce(co.outlets_visited, 0) as outlets_visited,
          coalesce(ct.outlets_total, 0) as outlets_total,
          coalesce(rc.beat_name, '-') as route_name,
          coalesce(mm.manager_name, '-') as manager_name,
          coalesce(d.distributor_name, '-') as distributor_name,
          co.last_active_at
        from salesmen s
        left join distributors d on d.id = s.distributor_id
        left join current_metrics cm on cm.entity_id = s.id::text
        left join previous_metrics pm on pm.entity_id = s.id::text
        left join current_orders co on co.salesman_id = s.id
        left join current_outlets ct on ct.salesman_id = s.id
        left join route_candidates rc on rc.salesman_id = s.id
        left join manager_matches mm on mm.salesman_id = s.id
        where s.tenant_id = $1 and s.active = true
        order by s.salesman_name asc
        `,
        [tenantId, snapshotDate, previousSnapshotDate, dateWindow.startDate, dateWindow.endDate]
      );

      mapped = rows.map((row: any) => ({
        id: String(row.salesman_id),
        name: row.salesman_name,
        salesmanId: String(row.salesman_id),
        zone: row.zone,
        region: row.region,
        area: row.area,
        revenueMTD: Number(row.revenue_mtd || 0),
        collectionMTD: Number(row.collection_mtd || 0),
        ordersMTD: Number(row.orders_mtd || 0),
        previousRevenueMTD: Number(row.previous_revenue_mtd || 0),
        previousCollectionMTD: Number(row.previous_collection_mtd || 0),
        outletsVisited: Number(row.outlets_visited || 0),
        outletsTotal: Number(row.outlets_total || 0),
        beatAdherence: Number(row.beat_adherence_pct || 0),
        coveragePct: Number(row.coverage_pct || 0),
        outstanding: Number(row.outstanding || 0),
        route: row.route_name || '-',
        manager: row.manager_name || '-',
        distributor: row.distributor_name || '-',
        lastActive: row.last_active_at
      }));
    } else if (entityType === 'retailer') {
      const rows = await this.db.query(
        `
        with current_metrics as (
          select
            entity_id,
            max(case when metric_key = 'revenue_mtd' then metric_value end) as revenue_mtd,
            max(case when metric_key = 'orders_mtd' then metric_value end) as orders_mtd,
            max(case when metric_key = 'aov' then metric_value end) as aov,
            max(case when metric_key = 'outstanding' then metric_value end) as outstanding,
            max(case when metric_key = 'dormancy_days' then metric_value end) as dormancy_days
          from entity_metric_snapshots
          where tenant_id = $1 and entity_type = 'retailer' and snapshot_date = $2::date
          group by entity_id
        ),
        order_history as (
          select
            so.tenant_outlet_id,
            count(*) as total_orders,
            min(so.order_sale_date) as first_order_date,
            max(so.order_sale_date) as last_order_date
          from sales_orders so
          where so.tenant_id = $1
          group by so.tenant_outlet_id
        ),
        latest_orders as (
          select *
          from (
            select
              so.tenant_outlet_id,
              so.order_sale_date,
              so.net_amount,
              row_number() over (
                partition by so.tenant_outlet_id
                order by so.order_sale_date desc, so.id desc
              ) as rn
            from sales_orders so
            where so.tenant_id = $1
          ) ranked
          where rn = 1
        )
        select
          o.id::text as retailer_id,
          o.outlet_name as retailer_name,
          coalesce(o.zone, d.zone, '-') as zone,
          coalesce(o.region, d.region, '-') as region,
          coalesce(o.area, d.area, '-') as area,
          coalesce(cm.revenue_mtd, 0) as revenue_mtd,
          coalesce(cm.orders_mtd, 0) as orders_mtd,
          coalesce(cm.aov, 0) as aov,
          coalesce(cm.outstanding, 0) as outstanding,
          coalesce(cm.dormancy_days, 0) as dormancy_days,
          lo.order_sale_date as last_order_date,
          coalesce(lo.net_amount, 0) as last_bill_value,
          coalesce(oh.total_orders, 0) as total_orders,
          oh.first_order_date,
          oh.last_order_date as last_order_date_all,
          coalesce(s.salesman_name, '-') as salesman_name,
          coalesce(d.distributor_name, '-') as distributor_name
        from tenant_outlets to2
        join outlets o on o.id = to2.outlet_id
        left join salesmen s on s.id = to2.salesman_id
        left join distributors d on d.id = to2.distributor_id
        left join current_metrics cm on cm.entity_id = o.id::text
        left join latest_orders lo on lo.tenant_outlet_id = to2.id
        left join order_history oh on oh.tenant_outlet_id = to2.id
        where to2.tenant_id = $1 and to2.active = true
        order by o.outlet_name asc
        `,
        [tenantId, snapshotDate]
      );

      mapped = rows.map((row: any) => {
        const totalOrders = Number(row.total_orders || 0);
        const firstOrderDate = toDateOnly(row.first_order_date);
        const lastOrderDateAll = toDateOnly(row.last_order_date_all);
        const repeatOrderFrequency =
          totalOrders > 1 && firstOrderDate && lastOrderDateAll
            ? daysBetweenDates(firstOrderDate, lastOrderDateAll) / Math.max(totalOrders - 1, 1)
            : 0;
        return {
          id: String(row.retailer_id),
          name: row.retailer_name,
          retailerId: String(row.retailer_id),
          zone: row.zone,
          region: row.region,
          area: row.area,
          revenueMTD: Number(row.revenue_mtd || 0),
          ordersMTD: Number(row.orders_mtd || 0),
          aov: Number(row.aov || 0),
          outstanding: Number(row.outstanding || 0),
          dormancyDays: Number(row.dormancy_days || 0),
          lastOrderDate: toDateOnly(row.last_order_date),
          lastBillValue: Number(row.last_bill_value || 0),
          repeatOrderFrequency,
          salesman: row.salesman_name || '-',
          distributor: row.distributor_name || '-'
        };
      });
    } else if (entityType === 'beat') {
      const rows = await this.db.query(
        `
        with current_metrics as (
          select
            entity_id,
            max(case when metric_key = 'revenue_mtd' then metric_value end) as revenue_mtd,
            max(case when metric_key = 'coverage_pct' then metric_value end) as coverage_pct,
            max(case when metric_key = 'realization_pct' then metric_value end) as realization_pct,
            max(case when metric_key = 'visits_mtd' then metric_value end) as visits_mtd,
            max(case when metric_key = 'ebv' then metric_value end) as ebv
          from entity_metric_snapshots
          where tenant_id = $1 and entity_type = 'beat' and snapshot_date = $2::date
          group by entity_id
        ),
        active_outlets as (
          select beat_id, count(distinct outlet_id) as active_outlets
          from sales_orders
          where tenant_id = $1
            and order_sale_date between $3::date and $4::date
            and beat_id is not null
          group by beat_id
        ),
        total_outlets as (
          select beat_id, count(distinct outlet_id) as total_outlets
          from beat_outlets
          where tenant_id = $1 and active = true and beat_id is not null
          group by beat_id
        ),
        dominant_salesman as (
          select *
          from (
            select
              so.beat_id,
              s.salesman_name,
              row_number() over (
                partition by so.beat_id
                order by count(*) desc, s.salesman_name asc
              ) as rn
            from sales_orders so
            join salesmen s on s.id = so.salesman_id
            where so.tenant_id = $1
              and so.order_sale_date between $3::date and $4::date
              and so.beat_id is not null
              and so.salesman_id is not null
            group by so.beat_id, s.salesman_name
          ) ranked
          where rn = 1
        )
        select
          b.id::text as beat_id,
          b.beat_name,
          coalesce(b.zone, d.zone, '-') as zone,
          coalesce(b.region, d.region, '-') as region,
          coalesce(b.area, d.area, '-') as area,
          coalesce(cm.revenue_mtd, 0) as revenue_mtd,
          coalesce(cm.coverage_pct, 0) as coverage_pct,
          coalesce(cm.realization_pct, 0) as realization_pct,
          coalesce(cm.visits_mtd, 0) as visits_mtd,
          coalesce(cm.ebv, 0) as ebv,
          coalesce(ao.active_outlets, 0) as active_outlets,
          coalesce(to2.total_outlets, 0) as total_outlets,
          coalesce(ds.salesman_name, '-') as salesman_name,
          coalesce(d.distributor_name, '-') as distributor_name
        from beats b
        left join distributors d on d.id = b.distributor_id
        left join current_metrics cm on cm.entity_id = b.id::text
        left join active_outlets ao on ao.beat_id = b.id
        left join total_outlets to2 on to2.beat_id = b.id
        left join dominant_salesman ds on ds.beat_id = b.id
        where b.tenant_id = $1 and b.active = true
        order by b.beat_name asc
        `,
        [tenantId, snapshotDate, dateWindow.startDate, dateWindow.endDate]
      );

      mapped = rows.map((row: any) => ({
        id: String(row.beat_id),
        name: row.beat_name,
        beatId: String(row.beat_id),
        beatName: row.beat_name,
        zone: row.zone,
        region: row.region,
        area: row.area,
        revenueMTD: Number(row.revenue_mtd || 0),
        ebv: Number(row.ebv || 0),
        visitsMTD: Number(row.visits_mtd || 0),
        activeOutlets: Number(row.active_outlets || 0),
        totalOutlets: Number(row.total_outlets || 0),
        coveragePct: Number(row.coverage_pct || 0),
        realizationPct: Number(row.realization_pct || 0),
        salesman: row.salesman_name || '-',
        distributor: row.distributor_name || '-'
      }));
    } else if (entityType === 'sku') {
      const rows = await this.db.query(
        `
        with current_metrics as (
          select
            entity_id,
            max(case when metric_key = 'revenue_mtd' then metric_value end) as revenue_mtd,
            max(case when metric_key = 'units_mtd' then metric_value end) as units_mtd,
            max(case when metric_key = 'outlets_mtd' then metric_value end) as outlets_mtd,
            max(case when metric_key = 'penetration_pct' then metric_value end) as penetration_pct,
            max(case when metric_key = 'growth_pct' then metric_value end) as growth_pct
          from entity_metric_snapshots
          where tenant_id = $1 and entity_type = 'sku' and snapshot_date = $2::date
          group by entity_id
        )
        select
          s.id::text as sku_id,
          s.name as sku_name,
          coalesce(b.brand_name, '-') as brand_name,
          coalesce(max(ems.zone), '-') as zone,
          coalesce(max(ems.region), '-') as region,
          coalesce(max(ems.area), '-') as area,
          coalesce(cm.revenue_mtd, 0) as revenue_mtd,
          coalesce(cm.units_mtd, 0) as units_mtd,
          coalesce(cm.outlets_mtd, 0) as outlets_mtd,
          coalesce(cm.penetration_pct, 0) as penetration_pct,
          coalesce(cm.growth_pct, 0) as growth_pct
        from skus s
        left join brands b on b.id = s.brand_id
        left join current_metrics cm on cm.entity_id = s.id::text
        left join entity_metric_snapshots ems
          on ems.tenant_id = $1
         and ems.entity_type = 'sku'
         and ems.entity_id = s.id::text
         and ems.snapshot_date = $2::date
        where s.tenant_id = $1 and s.active = true
        group by s.id, s.name, b.brand_name, cm.revenue_mtd, cm.units_mtd, cm.outlets_mtd, cm.penetration_pct, cm.growth_pct
        order by s.name asc
        `,
        [tenantId, snapshotDate]
      );

      mapped = rows.map((row: any) => ({
        id: String(row.sku_id),
        name: row.sku_name,
        skuId: String(row.sku_id),
        skuName: row.sku_name,
        brand: row.brand_name || '-',
        category: row.brand_name || '-',
        zone: row.zone,
        region: row.region,
        area: row.area,
        revenueMTD: Number(row.revenue_mtd || 0),
        unitsMTD: Number(row.units_mtd || 0),
        outletsMTD: Number(row.outlets_mtd || 0),
        penetrationPct: Number(row.penetration_pct || 0),
        growthPct: Number(row.growth_pct || 0)
      }));
    } else if (entityType === 'distributor') {
      const rows = await this.db.query(
        `
        with current_metrics as (
          select
            entity_id,
            max(case when metric_key = 'revenue_mtd' then metric_value end) as revenue_mtd,
            max(case when metric_key = 'orders_mtd' then metric_value end) as orders_mtd,
            max(case when metric_key = 'outstanding' then metric_value end) as outstanding,
            max(case when metric_key = 'fulfilment_pct' then metric_value end) as fulfilment_pct,
            max(case when metric_key = 'damage_pct' then metric_value end) as damage_pct
          from entity_metric_snapshots
          where tenant_id = $1 and entity_type = 'distributor' and snapshot_date = $2::date
          group by entity_id
        ),
        active_salesmen as (
          select distributor_id, count(*) as active_salesmen
          from salesmen
          where tenant_id = $1 and active = true and distributor_id is not null
          group by distributor_id
        ),
        active_outlets as (
          select distributor_id, count(distinct outlet_id) as active_outlets
          from tenant_outlets
          where tenant_id = $1 and active = true and distributor_id is not null
          group by distributor_id
        )
        select
          d.id::text as distributor_id,
          d.distributor_name,
          coalesce(d.zone, '-') as zone,
          coalesce(d.region, '-') as region,
          coalesce(d.area, '-') as area,
          coalesce(cm.revenue_mtd, 0) as revenue_mtd,
          coalesce(cm.orders_mtd, 0) as orders_mtd,
          coalesce(cm.outstanding, 0) as outstanding,
          coalesce(cm.fulfilment_pct, 0) as fulfilment_pct,
          coalesce(cm.damage_pct, 0) as damage_pct,
          coalesce(asl.active_salesmen, 0) as active_salesmen,
          coalesce(ao.active_outlets, 0) as active_outlets
        from distributors d
        left join current_metrics cm on cm.entity_id = d.id::text
        left join active_salesmen asl on asl.distributor_id = d.id
        left join active_outlets ao on ao.distributor_id = d.id
        where d.tenant_id = $1 and d.active = true
        order by d.distributor_name asc
        `,
        [tenantId, snapshotDate]
      );

      mapped = rows.map((row: any) => ({
        id: String(row.distributor_id),
        name: row.distributor_name,
        distributorId: String(row.distributor_id),
        distributorName: row.distributor_name,
        zone: row.zone,
        region: row.region,
        area: row.area,
        revenueMTD: Number(row.revenue_mtd || 0),
        ordersMTD: Number(row.orders_mtd || 0),
        outstanding: Number(row.outstanding || 0),
        fulfilmentPct: Number(row.fulfilment_pct || 0),
        damagePct: Number(row.damage_pct || 0),
        activeSalesmen: Number(row.active_salesmen || 0),
        activeOutlets: Number(row.active_outlets || 0)
      }));
    } else {
      const rows = await this.db.query(
        `
        select
          entity_id,
          max(entity_name) as entity_name,
          max(zone) as zone,
          max(region) as region,
          max(area) as area,
          max(case when metric_key = 'revenue_mtd' then metric_value end) as revenue_mtd,
          max(case when metric_key = 'collection_mtd' then metric_value end) as collection_mtd,
          max(case when metric_key = 'orders_mtd' then metric_value end) as orders_mtd,
          max(case when metric_key = 'coverage_pct' then metric_value end) as coverage_pct
        from entity_metric_snapshots
        where tenant_id = $1 and entity_type = 'geography' and snapshot_date = $2::date
        group by entity_id
        order by max(entity_name) asc
        `,
        [tenantId, snapshotDate]
      );

      mapped = rows.map((row: any) => ({
        id: String(row.entity_id),
        name: row.entity_name,
        zone: row.zone,
        region: row.region,
        area: row.area,
        revenueMTD: Number(row.revenue_mtd || 0),
        collectionMTD: Number(row.collection_mtd || 0),
        ordersMTD: Number(row.orders_mtd || 0),
        coveragePct: Number(row.coverage_pct || 0)
      }));
    }

    const limit = Number(query?.limit || 50);
    const page = Number(query?.page || 1);
    const start = (page - 1) * limit;
    const paged = mapped.slice(start, start + limit);
    return {
      data: paged,
      meta: {
        page,
        limit,
        total: mapped.length,
        totalPages: mapped.length ? Math.ceil(mapped.length / limit) : 1,
        snapshotDate,
        periodLabel: this.formatExplorePeriodLabel(snapshotDate),
        dayCount: Math.max(1, daysBetweenDates(dateWindow.startDate, dateWindow.endDate) + 1)
      }
    };
  }

  async getObserveEntityDetails(entityType: string, entityId: string, user?: IAuthUser, timeRange?: string) {
    const tenantId = await this.resolveTenantId(user);
    const dateWindow = await this.resolveInsightDateWindow(tenantId, timeRange);
    const signalDateClause = dateWindow ? `and detected_at::date between $4::date and $5::date` : '';
    const trendDateClause = dateWindow ? `and snapshot_date between $4::date and $5::date` : '';
    const signalParams = dateWindow
      ? [tenantId, entityType, entityId, dateWindow.startDate, dateWindow.endDate]
      : [tenantId, entityType, entityId];
    const signals = await this.db.query(
      `
      select id, signal_key, severity, headline, description
      from entity_signals
      where tenant_id = $1 and entity_type = $2 and entity_id = $3
      ${signalDateClause}
      order by detected_at desc
      limit 20
      `,
      signalParams
    );
    const trendParams = dateWindow
      ? [tenantId, entityType, entityId, dateWindow.startDate, dateWindow.endDate]
      : [tenantId, entityType, entityId];
    const trends = await this.db.query(
      `
      select snapshot_date, metric_key, metric_value
      from entity_metric_snapshots
      where tenant_id = $1 and entity_type = $2 and entity_id = $3
      ${trendDateClause}
      order by snapshot_date desc
      limit 100
      `,
      trendParams
    );

    return {
      id: entityId,
      insights: signals.map((signal: any) => ({
        id: signal.id,
        title: signal.headline,
        detail: signal.description,
        severity: signal.severity
      })),
      trends: trends.map((point: any) => ({
        date: point.snapshot_date,
        metric: point.metric_key,
        value: Number(point.metric_value || 0)
      }))
    };
  }

  async listSignals(user?: IAuthUser, filters?: { entityType?: string; severity?: string }) {
    const tenantId = await this.resolveTenantId(user);
    const whereParts: string[] = ['tenant_id = $1'];
    const params: any[] = [tenantId];
    if (filters?.entityType) {
      whereParts.push(`entity_type = $${params.length + 1}`);
      params.push(filters.entityType);
    }
    if (filters?.severity) {
      whereParts.push(`severity = $${params.length + 1}`);
      params.push(filters.severity);
    }

    const rows = await this.db.query(
      `
      select *
      from entity_signals
      where ${whereParts.join(' and ')}
      order by detected_at desc
      limit 200
      `,
      params
    );
    return rows;
  }

  async getEntitySignals(user: IAuthUser | undefined, entityType: string, entityId: string) {
    const tenantId = await this.resolveTenantId(user);
    const rows = await this.db.query(
      `
      select *
      from entity_signals
      where tenant_id = $1 and entity_type = $2 and entity_id = $3
      order by detected_at desc
      `,
      [tenantId, entityType, entityId]
    );
    return rows;
  }

  async getSignalConfig(user?: IAuthUser) {
    const tenantId = await this.resolveTenantId(user);
    const rows = await this.db.query(
      `
      select
        sd.*,
        tst.threshold_value as tenant_threshold,
        tst.is_enabled as tenant_enabled
      from signal_definitions sd
      left join tenant_signal_thresholds tst
        on tst.signal_definition_id = sd.id and tst.tenant_id = $1 and tst.zone = 'NATIONAL'
      where sd.active = true
      order by sd.entity_type, sd.signal_key
      `,
      [tenantId]
    );
    const overrides = await this.db.query(
      `
      select tst.*, sd.entity_type, sd.signal_key
      from tenant_signal_thresholds tst
      join signal_definitions sd on sd.id = tst.signal_definition_id
      where tst.tenant_id = $1 and tst.zone <> 'NATIONAL'
      order by sd.entity_type, sd.signal_key, tst.zone
      `,
      [tenantId]
    );
    return { defaults: rows, overrides };
  }

  private async resolveSignalDefinitionId(
    tenantId: number,
    input: { signalDefinitionId?: number; entityType?: string; signalKey?: string }
  ): Promise<number> {
    if (input.signalDefinitionId) {
      return Number(input.signalDefinitionId);
    }
    if (!input.entityType || !input.signalKey) {
      throw new Error('signalDefinitionId or entityType+signalKey is required');
    }
    const rows = await this.db.query(`select id from signal_definitions where entity_type = $1 and signal_key = $2 limit 1`, [
      input.entityType,
      input.signalKey
    ]);
    const id = Number(rows[0]?.id);
    if (!id) {
      throw new Error(`Signal definition not found for ${input.entityType}/${input.signalKey}`);
    }
    const hasTenant = await this.db.query(`select id from tenants where id = $1`, [tenantId]);
    if (!hasTenant.length) {
      throw new Error('Invalid tenant');
    }
    return id;
  }

  async updateSignalDefaults(
    user: IAuthUser | undefined,
    defaults: Array<{ signalDefinitionId?: number; entityType?: string; signalKey?: string; thresholdValue: number; isEnabled?: boolean }>
  ) {
    const tenantId = await this.resolveTenantId(user);
    for (const item of defaults) {
      const signalDefinitionId = await this.resolveSignalDefinitionId(tenantId, item);
      await this.db.query(
        `
          insert into tenant_signal_thresholds (tenant_id, signal_definition_id, zone, threshold_value, is_enabled)
          values ($1,$2,'NATIONAL',$3,$4)
          on conflict (tenant_id, signal_definition_id, zone)
          do update set threshold_value = excluded.threshold_value, is_enabled = excluded.is_enabled, updated_at = now()
        `,
        [tenantId, signalDefinitionId, item.thresholdValue, item.isEnabled ?? true]
      );
    }
  }

  async updateSignalOverrides(
    user: IAuthUser | undefined,
    overrides: Array<{
      signalDefinitionId?: number;
      entityType?: string;
      signalKey?: string;
      zone: string;
      thresholdValue: number;
      isEnabled?: boolean;
    }>,
    replaceSignalDefinitionIds: number[] = []
  ) {
    const tenantId = await this.resolveTenantId(user);
    const normalizedOverrides: Array<{
      signalDefinitionId: number;
      zone: string;
      thresholdValue: number;
      isEnabled?: boolean;
    }> = [];

    for (const item of overrides) {
      const signalDefinitionId = await this.resolveSignalDefinitionId(tenantId, item);
      normalizedOverrides.push({
        signalDefinitionId,
        zone: this.normalizeZone(item.zone),
        thresholdValue: item.thresholdValue,
        isEnabled: item.isEnabled
      });
    }

    const definitionIdsToReplace = Array.from(
      new Set(
        [...replaceSignalDefinitionIds.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0), ...normalizedOverrides.map((item) => item.signalDefinitionId)]
      )
    );

    if (definitionIdsToReplace.length) {
      await this.db.query(
        `
          delete from tenant_signal_thresholds
          where tenant_id = $1
            and zone <> 'NATIONAL'
            and signal_definition_id = any($2::bigint[])
        `,
        [tenantId, definitionIdsToReplace]
      );
    }

    for (const item of normalizedOverrides) {
      await this.db.query(
        `
          insert into tenant_signal_thresholds (tenant_id, signal_definition_id, zone, threshold_value, is_enabled)
          values ($1,$2,$3,$4,$5)
          on conflict (tenant_id, signal_definition_id, zone)
          do update set threshold_value = excluded.threshold_value, is_enabled = excluded.is_enabled, updated_at = now()
        `,
        [tenantId, item.signalDefinitionId, item.zone, item.thresholdValue, item.isEnabled ?? true]
      );
    }
  }

  async resetSignalConfig(user?: IAuthUser, evaluateAfterReset = true) {
    const tenantId = await this.resolveTenantId(user);
    await this.db.query(`delete from tenant_signal_thresholds where tenant_id = $1`, [tenantId]);

    for (const [entityType, signalKey, threshold] of SIGNAL_DEFAULT_THRESHOLDS) {
      const rows = await this.db.query(`select id from signal_definitions where entity_type = $1 and signal_key = $2 limit 1`, [
        entityType,
        signalKey
      ]);
      const signalDefinitionId = Number(rows[0]?.id);
      if (!signalDefinitionId) {
        continue;
      }
      await this.db.query(
        `
          insert into tenant_signal_thresholds (tenant_id, signal_definition_id, zone, threshold_value, is_enabled)
          values ($1,$2,'NATIONAL',$3,true)
          on conflict (tenant_id, signal_definition_id, zone)
          do update set threshold_value = excluded.threshold_value, is_enabled = excluded.is_enabled, updated_at = now()
        `,
        [tenantId, signalDefinitionId, threshold]
      );
    }

    if (evaluateAfterReset) {
      await this.evaluateSignals(user, 'reset');
    }
  }

  async evaluateSignals(user?: IAuthUser, triggeredBy?: string) {
    const tenantId = await this.resolveTenantId(user);
    const runner = this.db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const runId = await this.evaluateSignalsInternal(runner, tenantId, triggeredBy || user?.id || 'manual');
      await runner.commitTransaction();
      return runId;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  async getActionsDashboard(user?: IAuthUser) {
    const tenantId = await this.resolveTenantId(user);
    return this.fetchActionDashboardInternal(tenantId);
  }

  async listActions(user?: IAuthUser, filters?: { status?: string }) {
    const tenantId = await this.resolveTenantId(user);
    const params: any[] = [tenantId];
    const whereParts = ['a.tenant_id = $1'];
    if (filters?.status) {
      params.push(filters.status);
      whereParts.push(`a.status = $${params.length}`);
    }

    const rows = await this.db.query(
      `
      select
        a.*,
        count(distinct at.id)::int as target_count
      from actions a
      left join action_targets at on at.action_id = a.id
      where ${whereParts.join(' and ')}
      group by a.id
      order by a.updated_at desc
      `,
      params
    );
    return {
      items: rows.map((row: any) => ({
        id: Number(row.id),
        type: row.type,
        typeLabel: this.mapActionTypeLabel(row.type),
        title: row.title,
        status: row.status,
        sourceKind: row.source_kind,
        sourceKey: row.source_key,
        sourceEntityType: row.source_entity_type,
        sourceEntityId: row.source_entity_id,
        sourceEntityName: row.source_entity_name,
        audienceType: row.audience_type,
        targetCount: Number(row.target_count || 0),
        payload: row.payload || {},
        deliverySummary: row.delivery_summary || {},
        deliverySummaryLabel: this.summarizeDeliverySummary(row.delivery_summary, Number(row.target_count || 0)),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    };
  }

  async getActionById(user: IAuthUser | undefined, actionId: number) {
    const tenantId = await this.resolveTenantId(user);
    const rows = await this.db.query(`select * from actions where tenant_id = $1 and id = $2 limit 1`, [tenantId, actionId]);
    const action = rows[0];
    if (!action) {
      throw new Error('Action not found');
    }
    const targets = await this.db.query(`select * from action_targets where action_id = $1 order by id asc`, [actionId]);
    const events = await this.db.query(
      `select * from action_events where tenant_id = $1 and action_id = $2 order by created_at desc`,
      [tenantId, actionId]
    );
    return {
      id: Number(action.id),
      type: action.type,
      typeLabel: this.mapActionTypeLabel(action.type),
      title: action.title,
      status: action.status,
      sourceKind: action.source_kind,
      sourceKey: action.source_key,
      sourceEntityType: action.source_entity_type,
      sourceEntityId: action.source_entity_id,
      sourceEntityName: action.source_entity_name,
      audienceType: action.audience_type,
      payload: action.payload || {},
      deliverySummary: action.delivery_summary || {},
      createdBy: action.created_by,
      createdAt: action.created_at,
      updatedAt: action.updated_at,
      targets: targets.map((target: any) => ({
        id: Number(target.id),
        entityType: target.entity_type,
        entityId: target.entity_id,
        entityName: target.entity_name,
        metadata: target.metadata || {}
      })),
      events: events.map((event: any) => ({
        id: Number(event.id),
        eventType: event.event_type,
        label: event.label,
        detail: event.detail,
        payload: event.payload || {},
        createdBy: event.created_by,
        createdAt: event.created_at
      }))
    };
  }

  async createAction(
    user: IAuthUser | undefined,
    payload: {
      type: string;
      title: string;
      status?: string;
      sourceKind?: string;
      sourceKey?: string | null;
      sourceEntityType?: string | null;
      sourceEntityId?: string | null;
      sourceEntityName?: string | null;
      audienceType?: string | null;
      payload?: Record<string, unknown>;
      targets?: Array<{ entityType: string; entityId: string; entityName?: string; metadata?: Record<string, unknown> }>;
      initialTask?: {
        assignee: string;
        instruction: string;
        deadline?: string | null;
        entityType?: string | null;
        entityId?: string | null;
        entityName?: string | null;
      };
    }
  ) {
    const tenantId = await this.resolveTenantId(user);
    const runner = this.db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const inserted = await runner.query(
        `
        insert into actions (
          tenant_id, type, title, status, source_kind, source_key, source_entity_type, source_entity_id, source_entity_name,
          audience_type, payload, delivery_summary, created_by
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13)
        returning id
        `,
        [
          tenantId,
          payload.type,
          payload.title,
          payload.status || 'draft',
          payload.sourceKind || 'manual',
          payload.sourceKey || null,
          payload.sourceEntityType || null,
          payload.sourceEntityId || null,
          payload.sourceEntityName || null,
          payload.audienceType || null,
          JSON.stringify(payload.payload || {}),
          JSON.stringify({ delivered: 0, responded: 0, targetCount: payload.targets?.length || 0 }),
          user?.id || 'system'
        ]
      );
      const actionId = Number(inserted[0]?.id);

      for (const target of payload.targets || []) {
        await runner.query(
          `
          insert into action_targets (action_id, entity_type, entity_id, entity_name, metadata)
          values ($1,$2,$3,$4,$5::jsonb)
          `,
          [actionId, target.entityType, target.entityId, target.entityName || null, JSON.stringify(target.metadata || {})]
        );
      }

      await runner.query(
        `
        insert into action_events (tenant_id, action_id, event_type, label, detail, payload, created_by)
        values ($1,$2,'created',$3,$4,$5::jsonb,$6)
        `,
        [
          tenantId,
          actionId,
          `Created ${this.mapActionTypeLabel(payload.type)}`,
          payload.title,
          JSON.stringify({ status: payload.status || 'draft', targetCount: payload.targets?.length || 0 }),
          user?.id || 'system'
        ]
      );

      if (payload.initialTask) {
        await runner.query(
          `
          insert into action_tasks (
            tenant_id, action_id, assignee, instruction, deadline, entity_type, entity_id, entity_name, status, created_by
          )
          values ($1,$2,$3,$4,$5::date,$6,$7,$8,'open',$9)
          `,
          [
            tenantId,
            actionId,
            payload.initialTask.assignee,
            payload.initialTask.instruction,
            payload.initialTask.deadline || null,
            payload.initialTask.entityType || null,
            payload.initialTask.entityId || null,
            payload.initialTask.entityName || null,
            user?.id || 'system'
          ]
        );
        await runner.query(
          `
          insert into action_events (tenant_id, action_id, event_type, label, detail, payload, created_by)
          values ($1,$2,'assign',$3,$4,$5::jsonb,$6)
          `,
          [
            tenantId,
            actionId,
            `Assigned task to ${payload.initialTask.assignee}`,
            payload.initialTask.instruction,
            JSON.stringify({ deadline: payload.initialTask.deadline || null }),
            user?.id || 'system'
          ]
        );
      }

      if (payload.sourceKind === 'signal' && payload.sourceKey) {
        await runner.query(`update entity_signals set action_state = 'actioned' where tenant_id = $1 and source_key = $2`, [
          tenantId,
          payload.sourceKey
        ]);
      }

      await runner.commitTransaction();
      return await this.getActionById(user, actionId);
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  async updateAction(
    user: IAuthUser | undefined,
    actionId: number,
    payload: { title?: string; status?: string; payload?: Record<string, unknown> }
  ) {
    const tenantId = await this.resolveTenantId(user);
    const existingRows = await this.db.query(`select * from actions where tenant_id = $1 and id = $2 limit 1`, [tenantId, actionId]);
    const existing = existingRows[0];
    if (!existing) {
      throw new Error('Action not found');
    }
    const nextTitle = payload.title || existing.title;
    const nextStatus = payload.status || existing.status;
    const nextPayload = payload.payload ? { ...(existing.payload || {}), ...payload.payload } : existing.payload || {};

    await this.db.query(
      `
      update actions
      set title = $3, status = $4, payload = $5::jsonb, updated_at = now()
      where tenant_id = $1 and id = $2
      `,
      [tenantId, actionId, nextTitle, nextStatus, JSON.stringify(nextPayload)]
    );

    if (payload.status && payload.status !== existing.status) {
      await this.db.query(
        `
        insert into action_events (tenant_id, action_id, event_type, label, detail, payload, created_by)
        values ($1,$2,'status_changed',$3,$4,$5::jsonb,$6)
        `,
        [
          tenantId,
          actionId,
          `Marked ${payload.status}`,
          nextTitle,
          JSON.stringify({ previousStatus: existing.status, nextStatus: payload.status }),
          user?.id || 'system'
        ]
      );
    } else {
      await this.db.query(
        `
        insert into action_events (tenant_id, action_id, event_type, label, detail, payload, created_by)
        values ($1,$2,'updated',$3,$4,$5::jsonb,$6)
        `,
        [tenantId, actionId, 'Updated action', nextTitle, JSON.stringify({}), user?.id || 'system']
      );
    }

    return this.getActionById(user, actionId);
  }

  async appendActionEvent(
    user: IAuthUser | undefined,
    actionId: number,
    payload: {
      eventType: string;
      label: string;
      detail?: string | null;
      payload?: Record<string, unknown>;
      task?: {
        assignee: string;
        instruction: string;
        deadline?: string | null;
        entityType?: string | null;
        entityId?: string | null;
        entityName?: string | null;
      };
    }
  ) {
    const tenantId = await this.resolveTenantId(user);
    const rows = await this.db.query(`select id from actions where tenant_id = $1 and id = $2 limit 1`, [tenantId, actionId]);
    if (!rows.length) {
      throw new Error('Action not found');
    }
    const inserted = await this.db.query(
      `
      insert into action_events (tenant_id, action_id, event_type, label, detail, payload, created_by)
      values ($1,$2,$3,$4,$5,$6::jsonb,$7)
      returning id, created_at
      `,
      [tenantId, actionId, payload.eventType, payload.label, payload.detail || null, JSON.stringify(payload.payload || {}), user?.id || 'system']
    );

    if (payload.task) {
      await this.createTask(user, { ...payload.task, actionId });
    }
    await this.db.query(`update actions set updated_at = now() where tenant_id = $1 and id = $2`, [tenantId, actionId]);

    return {
      id: Number(inserted[0]?.id),
      eventType: payload.eventType,
      label: payload.label,
      detail: payload.detail || null,
      createdAt: inserted[0]?.created_at
    };
  }

  async getActionLog(user?: IAuthUser) {
    const tenantId = await this.resolveTenantId(user);
    return this.fetchActionLogInternal(tenantId);
  }

  async listTasks(user?: IAuthUser) {
    const tenantId = await this.resolveTenantId(user);
    const rows = await this.db.query(`select * from action_tasks where tenant_id = $1 order by created_at desc`, [tenantId]);
    return {
      items: rows.map((task: any) => ({
        id: Number(task.id),
        actionId: task.action_id ? Number(task.action_id) : null,
        assignee: task.assignee,
        instruction: task.instruction,
        deadline: task.deadline,
        entityType: task.entity_type,
        entityId: task.entity_id,
        entityName: task.entity_name,
        status: task.status,
        createdAt: task.created_at,
        updatedAt: task.updated_at
      }))
    };
  }

  async createTask(
    user: IAuthUser | undefined,
    payload: {
      actionId?: number | null;
      assignee: string;
      instruction: string;
      deadline?: string | null;
      entityType?: string | null;
      entityId?: string | null;
      entityName?: string | null;
    }
  ) {
    const tenantId = await this.resolveTenantId(user);
    const actionId = payload.actionId ? Number(payload.actionId) : null;
    if (actionId) {
      const actionRows = await this.db.query(`select id from actions where tenant_id = $1 and id = $2 limit 1`, [tenantId, actionId]);
      if (!actionRows.length) {
        throw new Error('Action not found');
      }
    }
    const inserted = await this.db.query(
      `
      insert into action_tasks (
        tenant_id, action_id, assignee, instruction, deadline, entity_type, entity_id, entity_name, status, created_by
      )
      values ($1,$2,$3,$4,$5::date,$6,$7,$8,'open',$9)
      returning *
      `,
      [
        tenantId,
        actionId,
        payload.assignee,
        payload.instruction,
        payload.deadline || null,
        payload.entityType || null,
        payload.entityId || null,
        payload.entityName || null,
        user?.id || 'system'
      ]
    );
    const task = inserted[0];
    if (actionId) {
      await this.db.query(
        `
        insert into action_events (tenant_id, action_id, event_type, label, detail, payload, created_by)
        values ($1,$2,'assign',$3,$4,$5::jsonb,$6)
        `,
        [
          tenantId,
          actionId,
          `Assigned task to ${payload.assignee}`,
          payload.instruction,
          JSON.stringify({ deadline: payload.deadline || null }),
          user?.id || 'system'
        ]
      );
    }
    return {
      id: Number(task.id),
      actionId: task.action_id ? Number(task.action_id) : null,
      assignee: task.assignee,
      instruction: task.instruction,
      deadline: task.deadline,
      entityType: task.entity_type,
      entityId: task.entity_id,
      entityName: task.entity_name,
      status: task.status,
      createdAt: task.created_at,
      updatedAt: task.updated_at
    };
  }

  async updateTask(
    user: IAuthUser | undefined,
    taskId: number,
    payload: { status?: string; assignee?: string; instruction?: string; deadline?: string | null }
  ) {
    const tenantId = await this.resolveTenantId(user);
    const rows = await this.db.query(`select * from action_tasks where tenant_id = $1 and id = $2 limit 1`, [tenantId, taskId]);
    const existing = rows[0];
    if (!existing) {
      throw new Error('Task not found');
    }
    const updatedRows = await this.db.query(
      `
      update action_tasks
      set
        status = $3,
        assignee = $4,
        instruction = $5,
        deadline = $6::date,
        updated_at = now()
      where tenant_id = $1 and id = $2
      returning *
      `,
      [
        tenantId,
        taskId,
        payload.status || existing.status,
        payload.assignee || existing.assignee,
        payload.instruction || existing.instruction,
        payload.deadline === undefined ? existing.deadline : payload.deadline
      ]
    );
    const task = updatedRows[0];
    if (task.action_id && payload.status && payload.status !== existing.status) {
      await this.db.query(
        `
        insert into action_events (tenant_id, action_id, event_type, label, detail, payload, created_by)
        values ($1,$2,'updated',$3,$4,$5::jsonb,$6)
        `,
        [
          tenantId,
          task.action_id,
          payload.status === 'done' ? 'Completed task' : 'Re-opened task',
          task.instruction,
          JSON.stringify({ taskId }),
          user?.id || 'system'
        ]
      );
    }
    return {
      id: Number(task.id),
      actionId: task.action_id ? Number(task.action_id) : null,
      assignee: task.assignee,
      instruction: task.instruction,
      deadline: task.deadline,
      entityType: task.entity_type,
      entityId: task.entity_id,
      entityName: task.entity_name,
      status: task.status,
      createdAt: task.created_at,
      updatedAt: task.updated_at
    };
  }

  async deleteTask(user: IAuthUser | undefined, taskId: number) {
    const tenantId = await this.resolveTenantId(user);
    const rows = await this.db.query(`select * from action_tasks where tenant_id = $1 and id = $2 limit 1`, [tenantId, taskId]);
    const task = rows[0];
    if (!task) {
      throw new Error('Task not found');
    }
    await this.db.query(`delete from action_tasks where tenant_id = $1 and id = $2`, [tenantId, taskId]);
    if (task.action_id) {
      await this.db.query(
        `
        insert into action_events (tenant_id, action_id, event_type, label, detail, payload, created_by)
        values ($1,$2,'dismissed','Deleted task',$3,$4::jsonb,$5)
        `,
        [tenantId, task.action_id, task.instruction, JSON.stringify({ taskId }), user?.id || 'system']
      );
    }
  }

  async runCompare(
    user: IAuthUser | undefined,
    body: {
      compareDimension?: string;
      entityType?: string;
      selectedMetrics?: string[];
      metrics?: string[];
      selectedEntities?: string[];
      entityIds?: string[];
      filters?: Record<string, unknown>;
      timeRange?: string;
      periodLabel?: string;
      snapshotDate?: string;
    }
  ) {
    const tenantId = await this.resolveTenantId(user);
    const compareDimension = body.compareDimension || body.entityType;
    if (!compareDimension || !['geography', 'distributor', 'sku'].includes(compareDimension)) {
      throw new Error('compareDimension must be one of geography, distributor, sku');
    }

    const requestedMetrics = body.selectedMetrics || body.metrics || ['revenue'];
    const aliasByDimension: Record<string, Record<string, string>> = {
      geography: {
        revenue: 'revenue_mtd',
        collection: 'collection_mtd',
        orders: 'orders_mtd',
        coverage: 'coverage_pct'
      },
      distributor: {
        revenue: 'revenue_mtd',
        orders: 'orders_mtd',
        fulfilmentRate: 'fulfilment_pct',
        damage: 'damage_pct'
      },
      sku: {
        revenue: 'revenue_mtd',
        qty: 'units_mtd',
        penetration: 'penetration_pct',
        growth: 'growth_pct',
        outlets: 'outlets_mtd'
      }
    };
    const metricAlias = aliasByDimension[compareDimension] || {};
    const selectedMetrics = requestedMetrics.map((metric) => metricAlias[metric] || metric);
    const reverseMetricAlias = Object.entries(metricAlias).reduce<Record<string, string>>((acc, [uiMetric, dbMetric]) => {
      acc[dbMetric] = uiMetric;
      return acc;
    }, {});
    const selectedEntities = body.selectedEntities || body.entityIds || [];
    const periodLabel = body.periodLabel || body.timeRange || 'mtd';
    const snapshotDate = await this.resolveCompareSnapshotDate(tenantId, periodLabel, body.snapshotDate);
    if (!snapshotDate) {
      throw new Error('No snapshot data available');
    }

    const runRows = await this.db.query(
      `
        insert into compare_runs (
          tenant_id, compare_dimension, period_label, snapshot_date, filters, selected_metrics, selected_entities, run_status, created_by
        )
        values ($1,$2,$3,$4::date,$5::jsonb,$6::jsonb,$7::jsonb,'COMPLETED',$8)
        returning id
      `,
      [
        tenantId,
        compareDimension,
        periodLabel,
        snapshotDate,
        JSON.stringify(body.filters || {}),
        JSON.stringify(requestedMetrics),
        JSON.stringify(selectedEntities),
        user?.id || 'system'
      ]
    );
    const runId = Number(runRows[0].id);

    const entityFilterClause = selectedEntities.length ? `and entity_id = any($5::text[])` : '';
    const baseRows = await this.db.query(
      `
      select entity_id, max(entity_name) as entity_name, max(zone) as zone, max(region) as region, max(area) as area, metric_key, metric_value
      from entity_metric_snapshots
      where tenant_id = $1
        and entity_type = $2
        and snapshot_date = $3::date
        and metric_key = any($4::text[])
        ${entityFilterClause}
      group by entity_id, metric_key
      `,
      selectedEntities.length
        ? [tenantId, compareDimension, snapshotDate, selectedMetrics, selectedEntities]
        : [tenantId, compareDimension, snapshotDate, selectedMetrics]
    );

    const perMetric = new Map<string, number[]>();
    for (const row of baseRows) {
      const key = String(row.metric_key);
      const list = perMetric.get(key) || [];
      list.push(Number(row.metric_value || 0));
      perMetric.set(key, list);
    }

    const entityMap = new Map<string, { entityName: string; zone: string | null; region: string | null; area: string | null; metrics: Record<string, number> }>();
    for (const row of baseRows) {
      const entityId = String(row.entity_id);
      const existing: { entityName: string; zone: string | null; region: string | null; area: string | null; metrics: Record<string, number> } =
        entityMap.get(entityId) || {
          entityName: row.entity_name || entityId,
          zone: row.zone || null,
          region: row.region || null,
          area: row.area || null,
          metrics: {}
        };
      const uiMetric = reverseMetricAlias[String(row.metric_key)] || String(row.metric_key);
      existing.metrics[uiMetric] = Number(row.metric_value || 0);
      entityMap.set(entityId, existing);
    }

    const normalizeScore = (values: number[], value: number): number => {
      if (!values.length) return 0;
      const min = Math.min(...values);
      const max = Math.max(...values);
      if (max === min) return 100;
      return ((value - min) / (max - min)) * 100;
    };

    const results: any[] = [];
    for (const [entityId, info] of entityMap.entries()) {
      let scoreSum = 0;
      let scoreCount = 0;
      for (const metricKey of selectedMetrics) {
        const uiMetric = reverseMetricAlias[metricKey] || metricKey;
        const metricValues = perMetric.get(metricKey) || [];
        const value = Number(info.metrics[uiMetric] || 0);
        const sorted = [...metricValues].sort((a, b) => a - b);
        const rankIndex = sorted.findIndex((v) => v >= value);
        const percentile = sorted.length ? ((Math.max(rankIndex, 0) + 1) * 100) / sorted.length : 0;
        const avg = metricValues.length ? metricValues.reduce((acc, current) => acc + current, 0) / metricValues.length : 0;
        const top = metricValues.length ? Math.max(...metricValues) : 0;
        const normalized = normalizeScore(metricValues, value);
        scoreSum += normalized;
        scoreCount += 1;
        const compositeScore = scoreCount ? scoreSum / scoreCount : 0;

        await this.db.query(
          `
            insert into compare_results (
              compare_run_id, tenant_id, compare_dimension, entity_id, entity_name, zone, region, area, metric_key, metric_value,
              percentile_rank, index_to_average, gap_to_top, gap_to_average, composite_score, metadata
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
          `,
          [
            runId,
            tenantId,
            compareDimension,
            entityId,
            info.entityName,
            info.zone,
            info.region,
            info.area,
            metricKey,
            value,
            percentile,
            avg === 0 ? 0 : (value * 100) / avg,
            top - value,
            avg - value,
            compositeScore,
            JSON.stringify({})
          ]
        );

        results.push({
          runId,
          entityId,
          entityName: info.entityName,
              uiMetric,
              value,
              percentile,
              indexToAverage: avg === 0 ? 0 : (value * 100) / avg,
          gapToTop: top - value,
          gapToAverage: avg - value
        });
      }
    }

    const summary = selectedMetrics.map((metric) => {
      const values = perMetric.get(metric) || [];
      const uiMetric = reverseMetricAlias[metric] || metric;
      return {
        metric: uiMetric,
        average: values.length ? values.reduce((acc, current) => acc + current, 0) / values.length : 0,
        min: values.length ? Math.min(...values) : 0,
        max: values.length ? Math.max(...values) : 0
      };
    });

    const entities = Array.from(entityMap.entries()).map(([entityId, info]) => ({
      id: entityId,
      name: info.entityName,
      metrics: info.metrics
    }));

    return { runId, snapshotDate, summary, entities, results };
  }

  async getCompareRun(user: IAuthUser | undefined, runId: number) {
    const tenantId = await this.resolveTenantId(user);
    const runRows = await this.db.query(`select * from compare_runs where id = $1 and tenant_id = $2 limit 1`, [runId, tenantId]);
    if (!runRows.length) {
      throw new Error('Compare run not found');
    }
    const scopedResults = await this.db.query(
      `select * from compare_results where compare_run_id = $1 and tenant_id = $2 order by entity_name, metric_key`,
      [runId, tenantId]
    );
    return { run: runRows[0], results: scopedResults };
  }

  async saveComparePreset(
    user: IAuthUser | undefined,
    payload: {
      presetName: string;
      compareDimension: string;
      selectedMetrics: string[];
      selectedEntities: string[];
      filters?: Record<string, unknown>;
    }
  ) {
    const tenantId = await this.resolveTenantId(user);
    const rows = await this.db.query(
      `
      insert into compare_presets (
        tenant_id, preset_name, compare_dimension, selected_metrics, selected_entities, filters, created_by
      )
      values ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7)
      returning *
      `,
      [
        tenantId,
        payload.presetName,
        payload.compareDimension,
        JSON.stringify(payload.selectedMetrics),
        JSON.stringify(payload.selectedEntities),
        JSON.stringify(payload.filters || {}),
        user?.id || 'system'
      ]
    );
    return rows[0];
  }

  async listComparePresets(user?: IAuthUser) {
    const tenantId = await this.resolveTenantId(user);
    return this.db.query(`select * from compare_presets where tenant_id = $1 order by updated_at desc`, [tenantId]);
  }

  async getTrajectory(user: IAuthUser | undefined, query: { entityType: string; entityId: string; metricKey: string }) {
    const tenantId = await this.resolveTenantId(user);
    const rows = await this.db.query(
      `
      select snapshot_date, metric_value
      from entity_metric_snapshots
      where tenant_id = $1 and entity_type = $2 and entity_id = $3 and metric_key = $4
      order by snapshot_date asc
      `,
      [tenantId, query.entityType, query.entityId, query.metricKey]
    );

    const points = rows.map((row: any) => ({
      date: row.snapshot_date,
      value: Number(row.metric_value || 0)
    }));
    let slope = 0;
    if (points.length > 1) {
      slope = (points[points.length - 1].value - points[0].value) / (points.length - 1);
    }
    return {
      entityType: query.entityType,
      entityId: query.entityId,
      metricKey: query.metricKey,
      points,
      slope
    };
  }

  private async ensureAllTeamPerson(tenantId: number, entityType = 'salesman'): Promise<number> {
    const personCode = entityType === 'salesman' ? '__all__:salesman' : `__all__:${entityType}`;
    const existingCodes = entityType === 'salesman' ? ['__all__', '__all__:salesman'] : [personCode];
    const existing = await this.db.query(
      `select id from people where tenant_id = $1 and person_code = any($2::text[]) limit 1`,
      [tenantId, existingCodes]
    );
    if (existing.length) {
      return Number(existing[0].id);
    }
    const label = entityType.charAt(0).toUpperCase() + entityType.slice(1);
    const created = await this.db.query(
      `
        insert into people (tenant_id, person_code, full_name, role_code, role_name, active)
        values ($1, $2, $3, 'TEAM', $4, true)
        returning id
      `,
      [tenantId, personCode, `All ${label}`, `All ${label}`]
    );
    return Number(created[0].id);
  }

  private getAggregateEntityType(personCode?: string | null): string | null {
    if (!personCode) {
      return null;
    }
    if (personCode === '__all__') {
      return 'salesman';
    }
    if (!personCode.startsWith('__all__:')) {
      return null;
    }
    return personCode.slice('__all__:'.length) || null;
  }

  private shouldAverageTargetMetric(metricKey: string): boolean {
    return ['coverage_pct', 'beat_adherence_pct', 'penetration_pct', 'growth_pct', 'realization_pct', 'fulfilment_pct', 'damage_pct'].includes(
      metricKey
    );
  }

  private calculateTargetProgress(actualValue: number, baselineValue: number, targetValue: number, comparisonOperator: string): {
    progressPct: number;
    varianceValue: number;
    variancePct: number;
  } {
    if (targetValue <= 0) {
      return {
        progressPct: 0,
        varianceValue: 0,
        variancePct: 0
      };
    }

    if (comparisonOperator === 'LTE') {
      const denominator = baselineValue - targetValue;
      const varianceValue = targetValue - actualValue;
      const variancePct = (varianceValue * 100) / targetValue;
      return {
        progressPct: denominator > 0 ? ((baselineValue - actualValue) * 100) / denominator : actualValue <= targetValue ? 100 : 0,
        varianceValue,
        variancePct
      };
    }

    const denominator = targetValue - baselineValue;
    const varianceValue = actualValue - targetValue;
    const variancePct = (varianceValue * 100) / targetValue;
    return {
      progressPct: denominator > 0 ? ((actualValue - baselineValue) * 100) / denominator : actualValue >= targetValue ? 100 : 0,
      varianceValue,
      variancePct
    };
  }

  private async resolveAssignmentActualValue(
    runner: QueryRunner,
    assignment: {
      person_id: number;
      person_code?: string | null;
      metric_key: string;
      period_start_date: string;
      period_end_date: string;
      scope_level?: string | null;
      scope_value?: string | null;
    },
    tenantId: number
  ): Promise<number> {
    const aggregateEntityType = this.getAggregateEntityType(assignment.person_code);
    const scope = normalizeTargetScope(assignment.scope_level, assignment.scope_value);

    if (!aggregateEntityType) {
      const metricRows = await runner.query(
        `
        select metric_value
        from entity_metric_snapshots
        where tenant_id = $1
          and entity_type = 'person'
          and entity_id = $2
          and metric_key = $3
          and snapshot_date between $4::date and $5::date
        order by snapshot_date desc
        limit 1
        `,
        [tenantId, String(assignment.person_id), assignment.metric_key, assignment.period_start_date, assignment.period_end_date]
      );
      return Number(metricRows[0]?.metric_value || 0);
    }

    const scopedLatestDateFilters =
      scope.scopeLevel === 'zone'
        ? 'and zone = $6'
        : scope.scopeLevel === 'region'
          ? 'and region = $6'
          : scope.scopeLevel === 'area'
            ? 'and area = $6'
            : '';
    const scopedMetricFilters =
      scope.scopeLevel === 'zone'
        ? 'and zone = $5'
        : scope.scopeLevel === 'region'
          ? 'and region = $5'
          : scope.scopeLevel === 'area'
            ? 'and area = $5'
            : '';

    const latestRows = await runner.query(
      `
      select max(snapshot_date) as snapshot_date
      from entity_metric_snapshots
      where tenant_id = $1
        and entity_type = $2
        and metric_key = $3
        and snapshot_date between $4::date and $5::date
        ${scopedLatestDateFilters}
      `,
      scopedLatestDateFilters
        ? [tenantId, aggregateEntityType, assignment.metric_key, assignment.period_start_date, assignment.period_end_date, scope.scopeValue]
        : [tenantId, aggregateEntityType, assignment.metric_key, assignment.period_start_date, assignment.period_end_date]
    );
    const latestSnapshotDate = latestRows[0]?.snapshot_date;
    if (!latestSnapshotDate) {
      return 0;
    }

    const metricRows = await runner.query(
      `
      select metric_value
      from entity_metric_snapshots
      where tenant_id = $1
        and entity_type = $2
        and metric_key = $3
        and snapshot_date = $4::date
        ${scopedMetricFilters}
      `,
      scopedMetricFilters
        ? [tenantId, aggregateEntityType, assignment.metric_key, latestSnapshotDate, scope.scopeValue]
        : [tenantId, aggregateEntityType, assignment.metric_key, latestSnapshotDate]
    );
    const values = metricRows.map((row: any) => Number(row.metric_value || 0));
    if (!values.length) {
      return 0;
    }

    if (this.shouldAverageTargetMetric(assignment.metric_key)) {
      return values.reduce((sum: number, value: number) => sum + value, 0) / values.length;
    }

    return values.reduce((sum: number, value: number) => sum + value, 0);
  }

  private async ensurePersonForSalesman(tenantId: number, salesmanId: string | number): Promise<number> {
    const key = `salesman:${salesmanId}`;
    const existing = await this.db.query(`select id from people where tenant_id = $1 and person_code = $2 limit 1`, [tenantId, key]);
    if (existing.length) {
      return Number(existing[0].id);
    }
    const salesman = await this.db.query(`select salesman_name from salesmen where tenant_id = $1 and id = $2 limit 1`, [tenantId, salesmanId]);
    const fullName = salesman[0]?.salesman_name || `Salesman ${salesmanId}`;
    const created = await this.db.query(
      `
        insert into people (tenant_id, person_code, full_name, role_code, role_name, active)
        values ($1,$2,$3,'SO','Sales Officer',true)
        returning id
      `,
      [tenantId, key, fullName]
    );
    return Number(created[0].id);
  }

  async createPerson(
    user: IAuthUser | undefined,
    payload: {
      personCode?: string;
      fullName: string;
      roleCode?: string;
      roleName?: string;
      zone?: string;
      region?: string;
      area?: string;
      managerPersonId?: number;
    }
  ) {
    const tenantId = await this.resolveTenantId(user);
    const rows = await this.db.query(
      `
      insert into people (tenant_id, person_code, full_name, role_code, role_name, zone, region, area, manager_person_id, active)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
      returning *
      `,
      [
        tenantId,
        payload.personCode || null,
        payload.fullName,
        payload.roleCode || null,
        payload.roleName || null,
        payload.zone || null,
        payload.region || null,
        payload.area || null,
        payload.managerPersonId || null
      ]
    );
    return rows[0];
  }

  private async resolveTargetDefinitionId(tenantId: number, targetKey: string): Promise<number> {
    const rows = await this.db.query(`select id from target_definitions where tenant_id = $1 and target_key = $2 limit 1`, [
      tenantId,
      targetKey
    ]);
    if (!rows.length) {
      throw new Error(`Target definition not found for ${targetKey}`);
    }
    return Number(rows[0].id);
  }

  async createTargetAssignment(
    user: IAuthUser | undefined,
    payload: {
      personId: number;
      targetKey: string;
      assignmentName?: string;
      periodGranularity: 'month' | 'quarter';
      periodStartDate: string;
      periodEndDate: string;
      targetValue: number;
      baselineValue?: number;
      scopeLevel?: string;
      scopeValue?: string;
      stretchValue?: number;
      weightage?: number;
    }
  ) {
    const tenantId = await this.resolveTenantId(user);
    const targetDefinitionId = await this.resolveTargetDefinitionId(tenantId, payload.targetKey);
    const rows = await this.db.query(
      `
      insert into target_assignments (
        tenant_id, person_id, target_definition_id, assignment_name, period_granularity, period_start_date, period_end_date,
        target_value, baseline_value, scope_level, scope_value, stretch_value, weightage, status, created_by
      )
      values ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10,$11,$12,$13,'active',$14)
      returning *
      `,
      [
        tenantId,
        payload.personId,
        targetDefinitionId,
        payload.assignmentName || null,
        payload.periodGranularity,
        payload.periodStartDate,
        payload.periodEndDate,
        payload.targetValue,
        payload.baselineValue || 0,
        payload.scopeLevel || 'national',
        payload.scopeValue || 'all_india',
        payload.stretchValue || null,
        payload.weightage || null,
        user?.id || 'system'
      ]
    );
    return rows[0];
  }

  private computeTargetStatus(progressPct: number): 'on_track' | 'at_risk' | 'behind' {
    if (progressPct >= 100) {
      return 'on_track';
    }
    if (progressPct >= 80) {
      return 'at_risk';
    }
    return 'behind';
  }

  private async recomputeTargetProgressInternal(runner: QueryRunner, tenantId: number): Promise<void> {
    const today = getCurrentISTDate();
    const assignments = await runner.query(
      `
      select ta.*, td.metric_key, td.comparison_operator, p.person_code
      from target_assignments ta
      join target_definitions td on td.id = ta.target_definition_id
      join people p on p.id = ta.person_id
      where ta.tenant_id = $1 and ta.status = 'active'
      `,
      [tenantId]
    );

    for (const assignment of assignments) {
      const actualValue = await this.resolveAssignmentActualValue(runner, assignment, tenantId);
      const targetValue = Number(assignment.target_value || 0);
      const baselineValue = Number(assignment.baseline_value || 0);
      const { progressPct, varianceValue, variancePct } = this.calculateTargetProgress(
        actualValue,
        baselineValue,
        targetValue,
        String(assignment.comparison_operator || 'GTE')
      );
      const statusLabel = this.computeTargetStatus(progressPct);

      await runner.query(
        `delete from target_progress_snapshots where tenant_id = $1 and target_assignment_id = $2 and snapshot_date = $3::date`,
        [tenantId, assignment.id, today]
      );
      await runner.query(
        `
        insert into target_progress_snapshots (
          tenant_id, target_assignment_id, person_id, snapshot_date, actual_value, target_value, progress_pct,
          status_label, variance_value, variance_pct, metadata
        )
        values ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11::jsonb)
        `,
        [tenantId, assignment.id, assignment.person_id, today, actualValue, targetValue, progressPct, statusLabel, varianceValue, variancePct, JSON.stringify({})]
      );
    }
  }

  async recomputeTargets(user?: IAuthUser) {
    const tenantId = await this.resolveTenantId(user);
    const runner = this.db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await this.recomputeTargetProgressInternal(runner, tenantId);
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  async listTargets(user?: IAuthUser) {
    const tenantId = await this.resolveTenantId(user);
    const rows = await this.db.query(
      `
      select
        ta.id,
        ta.person_id,
        p.full_name,
        p.person_code,
        td.target_key,
        td.metric_key,
        ta.target_value,
        ta.baseline_value,
        ta.scope_level,
        ta.scope_value,
        ta.status,
        ta.assignment_name,
        ta.period_granularity,
        ta.period_start_date,
        ta.period_end_date,
        coalesce(tps.actual_value, 0) as actual_value,
        coalesce(tps.progress_pct, 0) as progress_pct,
        tps.status_label
      from target_assignments ta
      join people p on p.id = ta.person_id
      join target_definitions td on td.id = ta.target_definition_id
      left join lateral (
        select actual_value, progress_pct, status_label
        from target_progress_snapshots tps
        where tps.target_assignment_id = ta.id
        order by tps.snapshot_date desc
        limit 1
      ) tps on true
      where ta.tenant_id = $1
      order by ta.updated_at desc
      `,
      [tenantId]
    );

    const formatEntityLabel = (entityType: string) => {
      const labelMap: Record<string, string> = {
        salesman: 'All Salesmen',
        retailer: 'All Retailers',
        beat: 'All Beats',
        sku: 'All SKUs',
        distributor: 'All Distributors'
      };
      return labelMap[entityType] || 'All Entities';
    };

    return {
      targets: rows.map((row: any) => ({
        ...(String(row.person_code || '').startsWith('__all__:')
          ? {
              assignmentEntityType: String(row.person_code).slice('__all__:'.length),
              assigneeLabel: formatEntityLabel(String(row.person_code).slice('__all__:'.length))
            }
          : String(row.person_code || '') === '__all__'
            ? {
                assignmentEntityType: 'salesman',
                assigneeLabel: 'All Salesmen'
              }
            : {
                assignmentEntityType: 'salesman',
                assigneeLabel: row.full_name || null
              }),
        id: row.id,
        metric: normalizeTargetMetricKey(row.target_key),
        salesmanId: String(row.person_id),
        baselineValue: Number(row.baseline_value || 0),
        scopeLevel: row.scope_level || 'national',
        scopeValue: row.scope_value || 'all_india',
        periodLabel: `${row.period_start_date} -> ${row.period_end_date}`,
        startDate: row.period_start_date,
        endDate: row.period_end_date,
        targetValue: Number(row.target_value || 0),
        actualValue: Number(row.actual_value || 0),
        attainmentPct: Number(row.progress_pct || 0),
        status: row.status === 'cancelled' ? 'paused' : row.status,
        notes: row.assignment_name || null
      }))
    };
  }

  async getTargetsByPerson(user: IAuthUser | undefined, personId: number) {
    const tenantId = await this.resolveTenantId(user);
    const rows = await this.db.query(
      `
      select *
      from target_assignments
      where tenant_id = $1 and person_id = $2
      order by updated_at desc
      `,
      [tenantId, personId]
    );
    return rows;
  }

  async createLegacyTarget(
    user: IAuthUser | undefined,
    payload: {
      salesmanId?: string | number | null;
      assignmentEntityType?: string;
      metric: string;
      baselineValue?: number;
      scope?: {
        level?: string;
        value?: string;
      };
      targetValue: number;
      periodLabel?: string;
      startDate: string;
      endDate: string;
      notes?: string | null;
    }
  ) {
    const tenantId = await this.resolveTenantId(user);
    const aggregateEntityType = payload.assignmentEntityType || 'salesman';
    const personId = payload.salesmanId
      ? await this.ensurePersonForSalesman(tenantId, payload.salesmanId)
      : await this.ensureAllTeamPerson(tenantId, aggregateEntityType);
    const targetKeyMap: Record<string, string> = {
      revenue: 'revenue',
      collection: 'collection',
      coverage: 'coverage_pct',
      coverage_pct: 'coverage_pct',
      beat_adherence: 'beat_adherence',
      orders: 'orders',
      outstanding: 'outstanding_reduction',
      outstanding_reduction: 'outstanding_reduction'
    };
    const targetKey = targetKeyMap[payload.metric] || 'revenue';
    if (!payload.salesmanId && !isAggregateTargetEntityTypeSupported(targetKey, aggregateEntityType)) {
      throw new Error(`Metric ${payload.metric} is not supported for aggregate ${aggregateEntityType} targets`);
    }
    const scope = normalizeTargetScope(payload.scope?.level, payload.scope?.value);
    const assignment = await this.createTargetAssignment(user, {
      personId,
      targetKey,
      assignmentName: payload.notes || payload.periodLabel || null || undefined,
      periodGranularity: 'month',
      periodStartDate: toDateOnly(payload.startDate) || getCurrentISTDate(),
      periodEndDate: toDateOnly(payload.endDate) || getCurrentISTDate(),
      targetValue: payload.targetValue,
      baselineValue: payload.baselineValue || 0,
      scopeLevel: scope.scopeLevel,
      scopeValue: scope.scopeValue
    });
    await this.recomputeTargets(user);
    return assignment;
  }

  async updateLegacyTarget(user: IAuthUser | undefined, targetId: number, payload: { targetValue?: number; status?: string; notes?: string | null }) {
    const tenantId = await this.resolveTenantId(user);
    const statusMap: Record<string, string> = { active: 'active', completed: 'completed', paused: 'cancelled' };
    await this.db.query(
      `
      update target_assignments
      set target_value = coalesce($3, target_value),
          status = coalesce($4, status),
          assignment_name = coalesce($5, assignment_name),
          updated_at = now()
      where id = $1 and tenant_id = $2
      `,
      [targetId, tenantId, payload.targetValue ?? null, payload.status ? statusMap[payload.status] || payload.status : null, payload.notes ?? null]
    );
    await this.recomputeTargets(user);
    const rows = await this.db.query(`select * from target_assignments where id = $1 and tenant_id = $2 limit 1`, [targetId, tenantId]);
    return rows[0];
  }

  async deleteLegacyTarget(user: IAuthUser | undefined, targetId: number) {
    const tenantId = await this.resolveTenantId(user);
    await this.db.query(`update target_assignments set status = 'cancelled', updated_at = now() where id = $1 and tenant_id = $2`, [
      targetId,
      tenantId
    ]);
  }
}
