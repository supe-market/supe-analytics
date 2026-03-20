import { createHash } from 'crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { parse as parseCsv } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '../../config/env';
import { IAuthUser } from '../../types';
import {
  daysBetweenDates,
  formatISTDate,
  getCurrentISTDate,
  getCurrentISTMonthRange,
  getDateParts,
  shiftDate,
  startOfMonth,
  startOfQuarter,
  startOfYear
} from '../../utils/ist-date';

type ImportableFile = {
  filename: string;
  mimetype: string;
  toBuffer: () => Promise<Buffer>;
};

type JsonRecord = Record<string, unknown>;

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

const ORDERS_BOOK_HEADERS = [
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

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
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

function firstValue(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
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
    if (env.AUTH_BYPASS) {
      return String(env.DEV_TENANT_ID);
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

  private inferSourceCode(filename: string): 'CSV_UPLOAD' | 'XLSX_UPLOAD' {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
      return 'XLSX_UPLOAD';
    }
    return 'CSV_UPLOAD';
  }

  private parseSheet(
    buffer: Buffer,
    filename: string,
    sourceSheetName?: string
  ): { fileType: string; sheetName: string | null; headers: string[]; rows: JsonRecord[] } {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
      const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
      const sheetName = sourceSheetName && workbook.SheetNames.includes(sourceSheetName) ? sourceSheetName : workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<JsonRecord>(worksheet, { defval: '' });
      const headers = rows.length ? Object.keys(rows[0]) : [];
      return {
        fileType: lower.endsWith('.xls') ? 'xls' : 'xlsx',
        sheetName: sheetName || null,
        headers,
        rows
      };
    }

    const rows = parseCsv(buffer, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      trim: true
    }) as JsonRecord[];
    const headers = rows.length ? Object.keys(rows[0]) : [];
    return {
      fileType: 'csv',
      sheetName: null,
      headers,
      rows
    };
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

  private buildRowKey(row: JsonRecord): Record<string, unknown> {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[normalizeHeader(key)] = value;
    }
    return normalized;
  }

  private getMappedValue(
    row: Record<string, unknown>,
    mappingIndex: Map<string, string>,
    targetEntity: string,
    targetField: string,
    fallbackHeaders: string[]
  ): string {
    const mapKey = `${targetEntity}.${targetField}`;
    const mappedColumn = mappingIndex.get(mapKey);
    if (mappedColumn && row[mappedColumn] !== undefined && row[mappedColumn] !== null && String(row[mappedColumn]).trim()) {
      return String(row[mappedColumn]).trim();
    }
    return firstValue(row, fallbackHeaders.map(normalizeHeader));
  }

  private guessTypedValues(value: unknown): {
    valueText: string | null;
    valueNumeric: number | null;
    valueDate: string | null;
    valueTimestamp: string | null;
    valueBoolean: boolean | null;
    valueJson: unknown | null;
  } {
    if (value === undefined || value === null || value === '') {
      return {
        valueText: null,
        valueNumeric: null,
        valueDate: null,
        valueTimestamp: null,
        valueBoolean: null,
        valueJson: null
      };
    }

    if (typeof value === 'object') {
      return {
        valueText: JSON.stringify(value),
        valueNumeric: null,
        valueDate: null,
        valueTimestamp: null,
        valueBoolean: null,
        valueJson: value
      };
    }

    const valueText = String(value).trim();
    const lowered = valueText.toLowerCase();
    const valueBoolean = ['true', 'false', 'yes', 'no'].includes(lowered)
      ? lowered === 'true' || lowered === 'yes'
      : null;
    const valueNumeric = toNumber(valueText);
    const valueDate = toDateOnly(valueText);
    const tsCandidate = new Date(valueText);
    const valueTimestamp = Number.isNaN(tsCandidate.getTime()) ? null : tsCandidate.toISOString();

    return {
      valueText,
      valueNumeric,
      valueDate,
      valueTimestamp,
      valueBoolean,
      valueJson: null
    };
  }

  private async ensureDataSource(runner: QueryRunner, sourceCode: string): Promise<number> {
    const rows = await runner.query(
      `
      insert into data_sources (source_code, source_name)
      values ($1, $1)
      on conflict (source_code) do update set source_name = excluded.source_name
      returning id
    `,
      [sourceCode]
    );
    if (rows.length) {
      return Number(rows[0].id);
    }
    const fallback = await runner.query(`select id from data_sources where source_code = $1 limit 1`, [sourceCode]);
    return Number(fallback[0].id);
  }

  private async upsertSourceColumns(
    runner: QueryRunner,
    dataSourceId: number,
    headers: string[]
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    for (const header of headers) {
      const normalized = normalizeHeader(header);
      const rows = await runner.query(
        `
          insert into source_columns (data_source_id, column_name, normalized_name, is_active)
          values ($1, $2, $3, true)
          on conflict (data_source_id, column_name)
          do update set normalized_name = excluded.normalized_name, is_active = true
          returning id
        `,
        [dataSourceId, header, normalized]
      );
      map.set(header, Number(rows[0].id));
    }
    return map;
  }

  private async loadMappings(runner: QueryRunner, dataSourceId: number): Promise<Map<string, string>> {
    const rows = await runner.query(
      `
        select m.target_entity, m.target_field, c.normalized_name
        from source_column_mappings m
        join source_columns c on c.id = m.source_column_id
        where m.data_source_id = $1 and m.is_active = true
        order by m.priority asc
      `,
      [dataSourceId]
    );

    const result = new Map<string, string>();
    for (const row of rows) {
      const key = `${row.target_entity}.${row.target_field}`;
      if (!result.has(key)) {
        result.set(key, row.normalized_name);
      }
    }
    return result;
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

  private async canonicalizeRow(
    runner: QueryRunner,
    ctx: {
      tenantId: number;
      dataSourceId: number;
      importBatchId: number;
      rawRecordId: number;
      row: Record<string, unknown>;
      mappingIndex: Map<string, string>;
    }
  ): Promise<void> {
    const { tenantId, dataSourceId, importBatchId, rawRecordId, row, mappingIndex } = ctx;

    const zone = this.getMappedValue(row, mappingIndex, 'common', 'zone', ['Zone', 'zone']);
    const region = this.getMappedValue(row, mappingIndex, 'common', 'region', ['Region', 'Sub_Zone', 'region', 'Outlet_City']);
    const area = this.getMappedValue(row, mappingIndex, 'common', 'area', ['Area', 'State', 'area']);

    const distributorCode = this.getMappedValue(row, mappingIndex, 'distributors', 'distributor_code', ['DB_Code', 'Distributor_Code']);
    const distributorName = this.getMappedValue(row, mappingIndex, 'distributors', 'distributor_name', ['DB_Name', 'Distributor_Name']);
    const distributorId = await this.upsertDistributor(runner, tenantId, {
      code: distributorCode,
      name: distributorName,
      zone,
      region,
      area
    });

    const beatCode = this.getMappedValue(row, mappingIndex, 'beats', 'beat_code', ['Beat_ID', 'Beat_Code']);
    const beatName = this.getMappedValue(row, mappingIndex, 'beats', 'beat_name', ['Beat_Name', 'beat_name']);
    const beatId = await this.upsertBeat(runner, tenantId, {
      code: beatCode,
      name: beatName,
      zone,
      region,
      area,
      distributorId
    });

    const employeeCode = this.getMappedValue(row, mappingIndex, 'salesmen', 'employee_code', ['TM/SO_Code', 'employee_code']);
    const externalSalesmanId = this.getMappedValue(row, mappingIndex, 'salesmen', 'external_salesman_id', ['Sale_User_ID']);
    const salesmanName = this.getMappedValue(row, mappingIndex, 'salesmen', 'salesman_name', ['TM/SO_Name', 'Sale_Done_by']);
    const salesmanPhone = this.getMappedValue(row, mappingIndex, 'salesmen', 'phone_number', ['TM/SO_Phone', 'phone_number']);
    const salesmanId = await this.upsertSalesman(runner, tenantId, {
      externalSalesmanId,
      employeeCode,
      name: salesmanName,
      phoneNumber: salesmanPhone,
      zone,
      region,
      area,
      distributorId
    });

    const outletName = this.getMappedValue(row, mappingIndex, 'outlets', 'outlet_name', ['Outlet_Name']);
    const externalOutletCode = this.getMappedValue(row, mappingIndex, 'outlets', 'external_outlet_code', ['Outlet_ID']);
    const tenantOutletCode = this.getMappedValue(row, mappingIndex, 'tenant_outlets', 'tenant_outlet_code', ['Outlet_ID']);
    const outletMobile = this.getMappedValue(row, mappingIndex, 'outlets', 'mobile_number', ['Mobile_Number', 'Outlet_Mobile']);
    const outletAddress1 = this.getMappedValue(row, mappingIndex, 'outlets', 'address_line1', ['Address_1', 'Address']);
    const outletAddress2 = this.getMappedValue(row, mappingIndex, 'outlets', 'address_line2', ['Address_2']);
    const outletPincode = this.getMappedValue(row, mappingIndex, 'outlets', 'pincode', ['Pincode', 'Pin_Code']);
    const outletGst = this.getMappedValue(row, mappingIndex, 'outlets', 'gst_number', ['GST_Number', 'GST_No']);
    const orderDate = toDateOnly(
      this.getMappedValue(row, mappingIndex, 'sales_orders', 'order_sale_date', ['Sale_Date', 'Order_Date', 'Invoice_Date'])
    );

    const { outletId, tenantOutletId } = await this.upsertOutletWithTenant(runner, tenantId, {
      tenantOutletCode,
      externalOutletCode,
      outletName,
      mobileNumber: outletMobile,
      zone,
      region,
      area,
      addressLine1: outletAddress1,
      addressLine2: outletAddress2,
      pincode: outletPincode,
      gstNumber: outletGst,
      beatId,
      salesmanId,
      distributorId,
      orderDate
    });

    const brandName = this.getMappedValue(row, mappingIndex, 'brands', 'brand_name', ['Brand', 'Sub_Brand']);
    const categoryName = this.getMappedValue(row, mappingIndex, 'sku_categories', 'category_name', ['Category', 'Segment']);
    const brandId = await this.findOrCreateByName(runner, 'brands', 'brand_name', 'brand_code', brandName);
    const categoryId = await this.findOrCreateByName(runner, 'sku_categories', 'category_name', 'category_code', categoryName);

    const skuCode = this.getMappedValue(row, mappingIndex, 'skus', 'sku_code', ['SKU_Code', 'SKU_ID']);
    const externalSkuId = this.getMappedValue(row, mappingIndex, 'skus', 'external_sku_id', ['SKU_ID']);
    const skuName = this.getMappedValue(row, mappingIndex, 'skus', 'sku_name', ['Description', 'SKU_Name']);
    const packSize = this.getMappedValue(row, mappingIndex, 'skus', 'pack_size', ['Pack_Size']);
    const unitOfMeasure = this.getMappedValue(row, mappingIndex, 'skus', 'unit_of_measure', ['UOM']);
    const skuId = await this.upsertSku(runner, {
      skuCode,
      externalSkuId,
      skuName,
      packSize,
      unitOfMeasure,
      mrp: toNumber(this.getMappedValue(row, mappingIndex, 'skus', 'mrp', ['MRP'])),
      gstPercent: toNumber(this.getMappedValue(row, mappingIndex, 'skus', 'gst_percent', ['GST_Pct'])),
      zone,
      region,
      area,
      brandId,
      categoryId
    });

    const externalInvoiceNo = this.getMappedValue(row, mappingIndex, 'sales_orders', 'external_invoice_no', ['Invoice_ID', 'Invoice_No']);
    const externalAwbNo = this.getMappedValue(row, mappingIndex, 'sales_orders', 'external_awb_no', ['AWB_No']);
    const externalOrderId = this.getMappedValue(row, mappingIndex, 'sales_orders', 'external_order_id', ['Order_ID']);
    const orderPunchedAtRaw = this.getMappedValue(row, mappingIndex, 'sales_orders', 'order_punched_at', ['Order_Punched_At']);
    const orderPunchedAt = orderPunchedAtRaw ? new Date(orderPunchedAtRaw).toISOString() : null;

    const grossAmount = toNumber(this.getMappedValue(row, mappingIndex, 'sales_orders', 'gross_amount', ['Sale_Amount', 'Gross_Amount']));
    const discountAmount = toNumber(this.getMappedValue(row, mappingIndex, 'sales_orders', 'discount_amount', ['Discount']));
    const taxAmount = toNumber(this.getMappedValue(row, mappingIndex, 'sales_orders', 'tax_amount', ['Tax_Amount']));
    const netAmount = toNumber(this.getMappedValue(row, mappingIndex, 'sales_orders', 'net_amount', ['Net_Sale_Amount', 'Net_Amount']));
    const collectionsAmount = toNumber(this.getMappedValue(row, mappingIndex, 'sales_orders', 'collections_amount', ['Collection_Amount']));
    const outstandingAmount = toNumber(this.getMappedValue(row, mappingIndex, 'sales_orders', 'outstanding_amount', ['Outstanding_Amount']));
    const marginAmount = toNumber(this.getMappedValue(row, mappingIndex, 'sales_orders', 'decided_margin_amount', ['Margin_Amount']));

    const orderId = await this.upsertSalesOrder(runner, {
      tenantId,
      dataSourceId,
      importBatchId,
      externalOrderId,
      externalInvoiceNo,
      externalAwbNo,
      orderDate,
      orderPunchedAt,
      outletId,
      tenantOutletId,
      beatId,
      salesmanId,
      distributorId,
      grossAmount,
      discountAmount,
      taxAmount,
      netAmount,
      collectionsAmount,
      outstandingAmount,
      marginAmount,
      remarks: '',
      rawRecordId
    });

    if (skuId) {
      const orderedQuantity = toNumber(this.getMappedValue(row, mappingIndex, 'sales_order_items', 'ordered_quantity', ['Sale_Quantity'])) || 0;
      const unitPrice = toNumber(this.getMappedValue(row, mappingIndex, 'sales_order_items', 'unit_price', ['Unit_Price']));
      const lineNetAmount = toNumber(this.getMappedValue(row, mappingIndex, 'sales_order_items', 'net_amount', ['Net_Sale_Amount']));
      const externalLineId =
        this.getMappedValue(row, mappingIndex, 'sales_order_items', 'external_line_id', ['Line_ID']) ||
        createHash('sha1')
          .update(`${orderId}|${skuId}|${orderedQuantity}|${lineNetAmount || 0}|${orderDate || ''}`)
          .digest('hex');

      const orderItemId = await this.upsertSalesOrderItem(runner, {
        salesOrderId: orderId,
        skuId,
        externalLineId,
        orderedQuantity,
        unitPrice,
        grossAmount: toNumber(this.getMappedValue(row, mappingIndex, 'sales_order_items', 'gross_amount', ['Sale_Amount'])),
        discountAmount: toNumber(this.getMappedValue(row, mappingIndex, 'sales_order_items', 'discount_amount', ['Discount'])),
        taxAmount: toNumber(this.getMappedValue(row, mappingIndex, 'sales_order_items', 'tax_amount', ['Tax_Amount'])),
        netAmount: lineNetAmount,
        marginPercent: toNumber(this.getMappedValue(row, mappingIndex, 'sales_order_items', 'margin_percent', ['Margin_Pct'])),
        marginAmount: toNumber(this.getMappedValue(row, mappingIndex, 'sales_order_items', 'margin_amount', ['Margin_Amount'])),
        rawRecordId
      });
      await this.insertCanonicalLineage(runner, 'sales_order_items', orderItemId, rawRecordId, 'line_item');
    }

    const paymentAmount = toNumber(this.getMappedValue(row, mappingIndex, 'order_payments', 'amount', ['Payment_Amount']));
    const paymentMode = this.getMappedValue(row, mappingIndex, 'order_payments', 'payment_mode', ['Payment_Mode']);
    const paymentDate = toDateOnly(this.getMappedValue(row, mappingIndex, 'order_payments', 'payment_date', ['Payment_Date']));
    const transactionRef = this.getMappedValue(row, mappingIndex, 'order_payments', 'external_ref', ['Transaction_Ref', 'External_Ref']);
    if (paymentAmount && paymentAmount > 0) {
      const existingPayment = await runner.query(
        `
          select id from order_payments
          where tenant_id = $1 and sales_order_id = $2 and coalesce(external_ref,'') = coalesce($3,'') and coalesce(amount,0) = $4
          limit 1
        `,
        [tenantId, orderId, transactionRef || null, paymentAmount]
      );
      if (!existingPayment.length) {
        await runner.query(
          `
          insert into order_payments (tenant_id, sales_order_id, payment_date, payment_mode, amount, external_ref, source_record_id)
          values ($1,$2,$3::date,$4,$5,$6,$7)
        `,
          [tenantId, orderId, paymentDate, paymentMode || null, paymentAmount, transactionRef || null, rawRecordId]
        );
      }
    }

    await this.insertCanonicalLineage(runner, 'sales_orders', orderId, rawRecordId, 'order');
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
      select
        o.id::text as entity_id,
        o.outlet_name as entity_name,
        o.zone, o.region, o.area,
        coalesce(sum(so.net_amount), 0) as revenue_mtd,
        count(distinct so.id) as orders_mtd,
        coalesce(sum(so.outstanding_amount), 0) as mtd_outstanding,
        coalesce((
          select sum(so_all.outstanding_amount)
          from sales_orders so_all
          where so_all.tenant_id = $1
            and so_all.tenant_outlet_id = to2.id
        ), 0) as total_outstanding,
        max(so.order_sale_date) as last_order_date
      from tenant_outlets to2
      join outlets o on o.id = to2.outlet_id
      left join sales_orders so
        on so.tenant_outlet_id = to2.id
        and so.tenant_id = $1
        and so.order_sale_date between $2::date and $3::date
      where to2.tenant_id = $1 and to2.active = true
      group by o.id, o.outlet_name, o.zone, o.region, o.area
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
      for (const [metricKey, metricValue, unit] of [
        ['revenue_mtd', revenue, 'currency'],
        ['ebv', visits > 0 ? revenue / visits : 0, 'currency'],
        ['total_retailers', total, 'number'],
        ['visits_mtd', visits, 'number'],
        ['coverage_pct', coverage, 'percent'],
        ['realization_pct', coverage, 'percent'],
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
      select
        s.id::text as entity_id,
        s.name as entity_name,
        max(o.zone) as zone,
        max(o.region) as region,
        max(o.area) as area,
        coalesce(sum(soi.amount), 0) as revenue_mtd,
        coalesce(sum(soi.ordered_quantity), 0) as units_mtd,
        count(distinct so.outlet_id) as outlets_mtd
      from skus s
      left join sales_order_items soi on soi.sku_id = s.id
      left join sales_orders so
        on so.id = soi.sales_order_id and so.tenant_id = $1 and so.order_sale_date between $2::date and $3::date
      left join outlets o on o.id = so.outlet_id
      where s.tenant_id = $1 and s.active = true
      group by s.id, s.name
      `,
      [tenantId, range.start, range.end]
    );
    const outletCountRows = await runner.query(`select count(*)::int as total from tenant_outlets where tenant_id = $1 and active = true`, [
      tenantId
    ]);
    const totalOutlets = Number(outletCountRows[0]?.total || 0);
    for (const row of skuRows) {
      const outlets = Number(row.outlets_mtd || 0);
      for (const [metricKey, metricValue, unit] of [
        ['revenue_mtd', Number(row.revenue_mtd || 0), 'currency'],
        ['units_mtd', Number(row.units_mtd || 0), 'number'],
        ['outlets_mtd', outlets, 'number'],
        ['penetration_pct', totalOutlets > 0 ? (outlets * 100) / totalOutlets : 0, 'percent'],
        ['growth_pct', 0, 'percent']
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
    await runner.query(`delete from entity_signals where tenant_id = $1`, [tenantId]);
    const latestDateRows = await runner.query(`select max(snapshot_date) as latest_date from entity_metric_snapshots where tenant_id = $1`, [
      tenantId
    ]);
    const latestDate = latestDateRows[0]?.latest_date;
    if (!latestDate) {
      return runToken;
    }

    const definitions = await runner.query(`select * from signal_definitions where active = true order by entity_type, signal_key`);
    for (const def of definitions) {
      const range = this.resolveWindowRange(String(def.window_type || 'MTD'), String(latestDate));
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

        await runner.query(
          `
            insert into entity_signals (
              tenant_id, signal_definition_id, entity_type, entity_id, entity_name, severity, signal_key, headline,
              description, metric_key, observed_value, threshold_value, comparison_operator, breach_amount, zone, region, area,
              window_start_date, window_end_date, metadata
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::date,$19::date,$20::jsonb)
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
    if (!workbook.SheetNames.includes('orders_book')) {
      throw new Error('Sheet "orders_book" is required');
    }

    const worksheet = workbook.Sheets.orders_book;
    const headerRows = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1, raw: false, blankrows: false });
    const headers = (headerRows[0] || []).map((value) => String(value || '').trim());
    const rows = XLSX.utils.sheet_to_json<OrdersBookRow>(worksheet, { defval: '', raw: false });
    return { headers, rows };
  }

  private validateOrdersBook(headers: string[], rows: OrdersBookRow[]): ImportRowError[] {
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
      const rowNumber = index + 2;
      const sNo = this.readOrdersBookText(row, 'S.no') || String(index + 1);
      const requiredTextColumns: OrdersBookHeader[] = [
        'distributors.distributor_code',
        'beats.beat_code',
        'salesmen.salesman_code',
        'outlets.external_outlet_code',
        'tenant_outlets.tenant_outlet_code',
        'brands.brand_code',
        'skus.sku_code',
        'sales_order_items.external_line_id'
      ];

      for (const column of requiredTextColumns) {
        if (!this.readOrdersBookText(row, column)) {
          errors.push({
            sNo,
            rowNumber,
            column,
            message: 'is required'
          });
        }
      }

      const quantity = this.readOrdersBookNumber(row, 'sales_order_items.ordered_quantity');
      if (quantity === null || quantity <= 0) {
        errors.push({
          sNo,
          rowNumber,
          column: 'sales_order_items.ordered_quantity',
          message: 'must be a positive number'
        });
      }

      const invoiceNo = this.readOrdersBookText(row, 'sales_orders.external_invoice_no');
      const orderId = this.readOrdersBookText(row, 'sales_orders.external_order_id');
      if (!invoiceNo && !orderId) {
        errors.push({
          sNo,
          rowNumber,
          column: 'sales_orders.external_invoice_no|sales_orders.external_order_id',
          message: 'either external_invoice_no or external_order_id is required'
        });
      }

      const lineId = this.readOrdersBookText(row, 'sales_order_items.external_line_id');
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

  private async runPostImportSync(tenantId: number, triggeredBy: string): Promise<{ signalRunId: number }> {
    const runner = this.db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await this.refreshSnapshots(runner, tenantId);
      const signalRunId = await this.evaluateSignalsInternal(runner, tenantId, triggeredBy);
      await this.recomputeTargetProgressInternal(runner, tenantId);
      await runner.commitTransaction();
      return { signalRunId };
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  async createImport(user: IAuthUser | undefined, file: ImportableFile, meta?: { sourceCode?: string; sourceSheetName?: string }) {
    void meta;
    const tenantId = await this.resolveTenantId(user);
    const tenantCode = this.resolveTenantCode(user);
    const buffer = await file.toBuffer();
    const checksum = createHash('sha256').update(buffer).digest('hex');
    const { headers, rows } = this.parseOrdersBook(buffer, file.filename);
    const objectKey = env.S3_BUCKET ? await this.uploadToS3(tenantCode, file.filename, buffer, file.mimetype) : null;

    const batchRows = await this.db.query(
      `
      insert into import_batches (
        tenant_id, source_file_name, source_file_type, source_sheet_name, file_checksum, file_object_key,
        total_rows, total_columns, valid_rows, rejected_rows, import_status, notes
      )
      values ($1,$2,'xlsx','orders_book',$3,$4,$5,$6,0,0,'PROCESSING',null)
      returning id
      `,
      [tenantId, file.filename, checksum, objectKey, rows.length, headers.length]
    );
    const batchId = Number(batchRows[0].id);

    const validationErrors = this.validateOrdersBook(headers, rows);
    if (validationErrors.length) {
      await this.db.query(
        `
        update import_batches
        set valid_rows = 0,
            rejected_rows = $2,
            import_status = 'FAILED',
            notes = $3
        where id = $1
        `,
        [batchId, rows.length, JSON.stringify(validationErrors.slice(0, 200))]
      );
      const error = new ImportValidationError('Import validation failed', validationErrors);
      (error as any).batchId = batchId;
      throw error;
    }

    const runner = this.db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const sourceRowNumber = index + 2;

        const rawRows = await runner.query(
          `
          insert into raw_records (import_batch_id, source_row_number, raw_row_json)
          values ($1, $2, $3::jsonb)
          returning id
          `,
          [batchId, sourceRowNumber, JSON.stringify(row)]
        );
        const rawRecordId = Number(rawRows[0].id);

        const distributorCode = this.readOrdersBookText(row, 'distributors.distributor_code');
        const distributorName = this.readOrdersBookText(row, 'distributors.distributor_name') || distributorCode;
        const distributorZone = this.readOrdersBookText(row, 'distributors.zone') || null;
        const distributorRegion = this.readOrdersBookText(row, 'distributors.region') || null;
        const distributorArea = this.readOrdersBookText(row, 'distributors.area') || null;

        const distributorRows = await runner.query(
          `
          insert into distributors (tenant_id, distributor_code, distributor_name, zone, region, area, active)
          values ($1,$2,$3,$4,$5,$6,true)
          on conflict (tenant_id, distributor_code)
          do update set
            distributor_name = excluded.distributor_name,
            zone = excluded.zone,
            region = excluded.region,
            area = excluded.area,
            active = true,
            updated_at = now()
          returning id
          `,
          [tenantId, distributorCode, distributorName, distributorZone, distributorRegion, distributorArea]
        );
        const distributorId = Number(distributorRows[0].id);

        const beatCode = this.readOrdersBookText(row, 'beats.beat_code');
        const beatName = this.readOrdersBookText(row, 'beats.beat_name') || beatCode;
        const beatRows = await runner.query(
          `
          insert into beats (tenant_id, beat_code, beat_name, distributor_id, zone, region, area, active)
          values ($1,$2,$3,$4,$5,$6,$7,true)
          on conflict (tenant_id, beat_code)
          do update set
            beat_name = excluded.beat_name,
            distributor_id = excluded.distributor_id,
            zone = excluded.zone,
            region = excluded.region,
            area = excluded.area,
            active = true,
            updated_at = now()
          returning id
          `,
          [tenantId, beatCode, beatName, distributorId, distributorZone, distributorRegion, distributorArea]
        );
        const beatId = Number(beatRows[0].id);

        const salesmanCode = this.readOrdersBookText(row, 'salesmen.salesman_code');
        const salesmanRows = await runner.query(
          `
          insert into salesmen (
            tenant_id, salesman_code, salesman_name, employee_code, external_salesman_id, phone_number,
            zone, region, area, distributor_id, active
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
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
          returning id
          `,
          [
            tenantId,
            salesmanCode,
            this.readOrdersBookText(row, 'salesmen.salesman_name') || salesmanCode,
            this.readOrdersBookText(row, 'salesmen.employee_code') || null,
            this.readOrdersBookText(row, 'salesmen.external_salesman_id') || null,
            normalizePhone(this.readOrdersBookText(row, 'salesmen.phone_number')) || null,
            this.readOrdersBookText(row, 'salesmen.zone') || distributorZone,
            this.readOrdersBookText(row, 'salesmen.region') || distributorRegion,
            this.readOrdersBookText(row, 'salesmen.area') || distributorArea,
            distributorId
          ]
        );
        const salesmanId = Number(salesmanRows[0].id);

        const tenantOutletCode = this.readOrdersBookText(row, 'tenant_outlets.tenant_outlet_code');
        let outletId: number | null = null;
        const existingTenantOutletRows = await runner.query(
          `
          select to2.id as tenant_outlet_id, o.id as outlet_id
          from tenant_outlets to2
          join outlets o on o.id = to2.outlet_id
          where to2.tenant_id = $1 and to2.tenant_outlet_code = $2
          limit 1
          `,
          [tenantId, tenantOutletCode]
        );
        let tenantOutletId: number | null = existingTenantOutletRows.length ? Number(existingTenantOutletRows[0].tenant_outlet_id) : null;
        if (existingTenantOutletRows.length) {
          outletId = Number(existingTenantOutletRows[0].outlet_id);
        } else {
          const insertedOutletRows = await runner.query(
            `
            insert into outlets (
              external_outlet_code, outlet_name, mobile_number, gst_number, address_line1, address_line2, pincode,
              latitude, longitude, zone, region, area, active
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)
            returning id
            `,
            [
              this.readOrdersBookText(row, 'outlets.external_outlet_code'),
              this.readOrdersBookText(row, 'outlets.outlet_name') || this.readOrdersBookText(row, 'outlets.external_outlet_code'),
              normalizePhone(this.readOrdersBookText(row, 'outlets.mobile_number')) || null,
              this.readOrdersBookText(row, 'outlets.gst_number') || null,
              this.readOrdersBookText(row, 'outlets.address_line1') || null,
              this.readOrdersBookText(row, 'outlets.address_line2') || null,
              this.readOrdersBookText(row, 'outlets.pincode') || null,
              this.readOrdersBookNumber(row, 'outlets.latitude'),
              this.readOrdersBookNumber(row, 'outlets.longitude'),
              this.readOrdersBookText(row, 'outlets.zone') || distributorZone,
              this.readOrdersBookText(row, 'outlets.region') || distributorRegion,
              this.readOrdersBookText(row, 'outlets.area') || distributorArea
            ]
          );
          outletId = Number(insertedOutletRows[0].id);
        }

        await runner.query(
          `
          update outlets
          set external_outlet_code = $2,
              outlet_name = $3,
              mobile_number = $4,
              gst_number = $5,
              address_line1 = $6,
              address_line2 = $7,
              pincode = $8,
              latitude = $9,
              longitude = $10,
              zone = $11,
              region = $12,
              area = $13,
              active = true,
              updated_at = now()
          where id = $1
          `,
          [
            outletId,
            this.readOrdersBookText(row, 'outlets.external_outlet_code') || null,
            this.readOrdersBookText(row, 'outlets.outlet_name') || null,
            normalizePhone(this.readOrdersBookText(row, 'outlets.mobile_number')) || null,
            this.readOrdersBookText(row, 'outlets.gst_number') || null,
            this.readOrdersBookText(row, 'outlets.address_line1') || null,
            this.readOrdersBookText(row, 'outlets.address_line2') || null,
            this.readOrdersBookText(row, 'outlets.pincode') || null,
            this.readOrdersBookNumber(row, 'outlets.latitude'),
            this.readOrdersBookNumber(row, 'outlets.longitude'),
            this.readOrdersBookText(row, 'outlets.zone') || distributorZone,
            this.readOrdersBookText(row, 'outlets.region') || distributorRegion,
            this.readOrdersBookText(row, 'outlets.area') || distributorArea
          ]
        );

        const orderSaleDate = this.readOrdersBookDate(row, 'sales_orders.order_sale_date');
        const tenantOutletRows = await runner.query(
          `
          insert into tenant_outlets (
            tenant_id, outlet_id, tenant_outlet_code, salesman_id, distributor_id, servicing_status, active, first_order_date, last_order_date
          )
          values ($1,$2,$3,$4,$5,$6,true,$7::date,$7::date)
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
          returning id
          `,
          [
            tenantId,
            outletId,
            tenantOutletCode,
            salesmanId,
            distributorId,
            'active',
            orderSaleDate
          ]
        );
        tenantOutletId = Number(tenantOutletRows[0].id);

        await runner.query(
          `
          update beat_outlets
          set active = false,
              removed_at = now(),
              removed_by = 'ingestion',
              updated_at = now()
          where tenant_id = $1 and outlet_id = $2 and beat_id <> $3 and active = true
          `,
          [tenantId, outletId, beatId]
        );
        await runner.query(
          `
          insert into beat_outlets (tenant_id, beat_id, outlet_id, active, assigned_at, assigned_by, removed_at, removed_by)
          values ($1,$2,$3,true,coalesce($4::timestamptz, now()),'ingestion',null,null)
          on conflict (tenant_id, beat_id, outlet_id)
          do update set
            active = true,
            removed_at = null,
            removed_by = null,
            assigned_at = coalesce(beat_outlets.assigned_at, excluded.assigned_at),
            updated_at = now()
          `,
          [tenantId, beatId, outletId, this.readOrdersBookTimestamp(row, 'sales_orders.order_punched_at')]
        );

        const brandCode = this.readOrdersBookText(row, 'brands.brand_code');
        let brandRows = await runner.query(`select id from brands where tenant_id = $1 and brand_code = $2 limit 1`, [tenantId, brandCode]);
        if (!brandRows.length) {
          brandRows = await runner.query(`select id from brands where tenant_id = $1 and lower(brand_name) = lower($2) limit 1`, [
            tenantId,
            this.readOrdersBookText(row, 'brands.brand_name')
          ]);
        }
        let brandId: number;
        if (brandRows.length) {
          brandId = Number(brandRows[0].id);
          await runner.query(
            `
            update brands
            set brand_code = $2, brand_name = $3, active = true, updated_at = now()
            where id = $1
            `,
            [brandId, brandCode || null, this.readOrdersBookText(row, 'brands.brand_name') || brandCode]
          );
        } else {
          const insertedBrandRows = await runner.query(
            `
            insert into brands (tenant_id, brand_code, brand_name, active)
            values ($1,$2,$3,true)
            returning id
            `,
            [tenantId, brandCode || null, this.readOrdersBookText(row, 'brands.brand_name') || brandCode]
          );
          brandId = Number(insertedBrandRows[0].id);
        }

        const skuRows = await runner.query(
          `
          insert into skus (
            tenant_id, sku_code, name, brand_id, hsn_code, mrp, discount_amount, discount_percent, rate,
            sgst_percent, sgst_amount, cgst_percent, cgst_amount, amount, weight, length_cm, width_cm, height_cm,
            igst_percent, igst_amount, active
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,true)
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
          returning id
          `,
          [
            tenantId,
            this.readOrdersBookText(row, 'skus.sku_code'),
            this.readOrdersBookText(row, 'skus.name') || this.readOrdersBookText(row, 'skus.sku_code'),
            brandId,
            this.readOrdersBookText(row, 'skus.hsn_code') || null,
            this.readOrdersBookNumber(row, 'skus.mrp'),
            this.readOrdersBookNumber(row, 'skus.discount_amount'),
            this.readOrdersBookNumber(row, 'skus.discount_percent'),
            this.readOrdersBookNumber(row, 'skus.rate'),
            this.readOrdersBookNumber(row, 'skus.sgst_percent'),
            this.readOrdersBookNumber(row, 'skus.sgst_amount'),
            this.readOrdersBookNumber(row, 'skus.cgst_percent'),
            this.readOrdersBookNumber(row, 'skus.cgst_amount'),
            this.readOrdersBookNumber(row, 'skus.amount'),
            this.readOrdersBookNumber(row, 'skus.weight'),
            this.readOrdersBookNumber(row, 'skus.length_cm'),
            this.readOrdersBookNumber(row, 'skus.width_cm'),
            this.readOrdersBookNumber(row, 'skus.height_cm'),
            this.readOrdersBookNumber(row, 'skus.igst_percent'),
            this.readOrdersBookNumber(row, 'skus.igst_amount')
          ]
        );
        const skuId = Number(skuRows[0].id);

        const invoiceNo = this.readOrdersBookText(row, 'sales_orders.external_invoice_no');
        const externalOrderId = this.readOrdersBookText(row, 'sales_orders.external_order_id');
        const existingOrderRows = invoiceNo
          ? await runner.query(`select id from sales_orders where tenant_id = $1 and external_invoice_no = $2 limit 1`, [tenantId, invoiceNo])
          : await runner.query(`select id from sales_orders where tenant_id = $1 and external_order_id = $2 limit 1`, [tenantId, externalOrderId]);

        let salesOrderId: number;
        if (existingOrderRows.length) {
          salesOrderId = Number(existingOrderRows[0].id);
          await runner.query(
            `
            update sales_orders
            set import_batch_id = $2,
                external_order_id = $3,
                external_invoice_no = $4,
                external_awb_no = $5,
                order_punched_at = $6::timestamptz,
                order_sale_date = $7::date,
                outlet_id = $8,
                tenant_outlet_id = $9,
                beat_id = $10,
                salesman_id = $11,
                distributor_id = $12,
                gross_amount = $13,
                discount_amount = $14,
                tax_amount = $15,
                net_amount = $16,
                collections_amount = $17,
                outstanding_amount = $18,
                decided_margin_amount = $19,
                remarks = $20,
                latest_source_record_id = $21,
                updated_at = now()
            where id = $1
            `,
            [
              salesOrderId,
              batchId,
              externalOrderId || null,
              invoiceNo || null,
              this.readOrdersBookText(row, 'sales_orders.external_awb_no') || null,
              this.readOrdersBookTimestamp(row, 'sales_orders.order_punched_at'),
              orderSaleDate,
              outletId,
              tenantOutletId,
              beatId,
              salesmanId,
              distributorId,
              this.readOrdersBookNumber(row, 'sales_orders.gross_amount'),
              this.readOrdersBookNumber(row, 'sales_orders.discount_amount'),
              this.readOrdersBookNumber(row, 'sales_orders.tax_amount'),
              this.readOrdersBookNumber(row, 'sales_orders.net_amount'),
              this.readOrdersBookNumber(row, 'sales_orders.collections_amount'),
              this.readOrdersBookNumber(row, 'sales_orders.outstanding_amount'),
              this.readOrdersBookNumber(row, 'sales_orders.decided_margin_amount'),
              this.readOrdersBookText(row, 'sales_orders.remarks') || null,
              rawRecordId
            ]
          );
        } else {
          const insertedOrderRows = await runner.query(
            `
            insert into sales_orders (
              tenant_id, import_batch_id, external_order_id, external_invoice_no, external_awb_no, order_punched_at, order_sale_date,
              outlet_id, tenant_outlet_id, beat_id, salesman_id, distributor_id, gross_amount, discount_amount, tax_amount, net_amount,
              collections_amount, outstanding_amount, decided_margin_amount, remarks, first_source_record_id, latest_source_record_id
            )
            values ($1,$2,$3,$4,$5,$6::timestamptz,$7::date,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)
            returning id
            `,
            [
              tenantId,
              batchId,
              externalOrderId || null,
              invoiceNo || null,
              this.readOrdersBookText(row, 'sales_orders.external_awb_no') || null,
              this.readOrdersBookTimestamp(row, 'sales_orders.order_punched_at'),
              orderSaleDate,
              outletId,
              tenantOutletId,
              beatId,
              salesmanId,
              distributorId,
              this.readOrdersBookNumber(row, 'sales_orders.gross_amount'),
              this.readOrdersBookNumber(row, 'sales_orders.discount_amount'),
              this.readOrdersBookNumber(row, 'sales_orders.tax_amount'),
              this.readOrdersBookNumber(row, 'sales_orders.net_amount'),
              this.readOrdersBookNumber(row, 'sales_orders.collections_amount'),
              this.readOrdersBookNumber(row, 'sales_orders.outstanding_amount'),
              this.readOrdersBookNumber(row, 'sales_orders.decided_margin_amount'),
              this.readOrdersBookText(row, 'sales_orders.remarks') || null,
              rawRecordId
            ]
          );
          salesOrderId = Number(insertedOrderRows[0].id);
        }
        await this.insertCanonicalLineage(runner, 'sales_orders', salesOrderId, rawRecordId, 'order');

        const lineId = this.readOrdersBookText(row, 'sales_order_items.external_line_id');
        const salesOrderItemRows = await runner.query(
          `
          insert into sales_order_items (
            sales_order_id, sku_id, external_line_id, ordered_quantity, rate, discount_amount, discount_percent,
            sgst_percent, sgst_amount, cgst_percent, cgst_amount, igst_percent, igst_amount, tax_amount, amount,
            first_source_record_id, latest_source_record_id
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
          on conflict (sales_order_id, external_line_id)
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
            amount = excluded.amount,
            latest_source_record_id = excluded.latest_source_record_id
          returning id
          `,
          [
            salesOrderId,
            skuId,
            lineId,
            this.readOrdersBookNumber(row, 'sales_order_items.ordered_quantity'),
            this.readOrdersBookNumber(row, 'sales_order_items.rate'),
            this.readOrdersBookNumber(row, 'sales_order_items.discount_amount'),
            this.readOrdersBookNumber(row, 'sales_order_items.discount_percent'),
            this.readOrdersBookNumber(row, 'sales_order_items.sgst_percent'),
            this.readOrdersBookNumber(row, 'sales_order_items.sgst_amount'),
            this.readOrdersBookNumber(row, 'sales_order_items.cgst_percent'),
            this.readOrdersBookNumber(row, 'sales_order_items.cgst_amount'),
            this.readOrdersBookNumber(row, 'sales_order_items.igst_percent'),
            this.readOrdersBookNumber(row, 'sales_order_items.igst_amount'),
            this.readOrdersBookNumber(row, 'sales_order_items.tax_amount'),
            this.readOrdersBookNumber(row, 'sales_order_items.amount'),
            rawRecordId
          ]
        );
        const salesOrderItemId = Number(salesOrderItemRows[0].id);
        await this.insertCanonicalLineage(runner, 'sales_order_items', salesOrderItemId, rawRecordId, 'line_item');

        const paymentAmount = this.readOrdersBookNumber(row, 'order_payments.amount');
        const paymentExternalRef = this.readOrdersBookText(row, 'order_payments.external_ref');
        if (paymentAmount !== null && paymentAmount > 0) {
          let paymentRows: any[] = [];
          if (paymentExternalRef) {
            paymentRows = await runner.query(
              `
              select id from order_payments
              where tenant_id = $1 and sales_order_id = $2 and external_ref = $3
              limit 1
              `,
              [tenantId, salesOrderId, paymentExternalRef]
            );
          } else {
            paymentRows = await runner.query(
              `
              select id from order_payments
              where tenant_id = $1 and sales_order_id = $2 and payment_date = $3::date
                and coalesce(payment_mode,'') = coalesce($4,'')
                and amount = $5
                and external_ref is null
              limit 1
              `,
              [
                tenantId,
                salesOrderId,
                this.readOrdersBookDate(row, 'order_payments.payment_date'),
                this.readOrdersBookText(row, 'order_payments.payment_mode') || null,
                paymentAmount
              ]
            );
          }

          let paymentId: number;
          if (paymentRows.length) {
            paymentId = Number(paymentRows[0].id);
            await runner.query(
              `
              update order_payments
              set payment_date = $2::date,
                  payment_mode = $3,
                  amount = $4,
                  external_ref = $5,
                  source_record_id = $6
              where id = $1
              `,
              [
                paymentId,
                this.readOrdersBookDate(row, 'order_payments.payment_date'),
                this.readOrdersBookText(row, 'order_payments.payment_mode') || null,
                paymentAmount,
                paymentExternalRef || null,
                rawRecordId
              ]
            );
          } else {
            const insertedPaymentRows = await runner.query(
              `
              insert into order_payments (tenant_id, sales_order_id, payment_date, payment_mode, amount, external_ref, source_record_id)
              values ($1,$2,$3::date,$4,$5,$6,$7)
              returning id
              `,
              [
                tenantId,
                salesOrderId,
                this.readOrdersBookDate(row, 'order_payments.payment_date'),
                this.readOrdersBookText(row, 'order_payments.payment_mode') || null,
                paymentAmount,
                paymentExternalRef || null,
                rawRecordId
              ]
            );
            paymentId = Number(insertedPaymentRows[0].id);
          }
          await this.insertCanonicalLineage(runner, 'order_payments', paymentId, rawRecordId, 'payment');
        }
      }

      await runner.commitTransaction();
    } catch (error: any) {
      await runner.rollbackTransaction();
      await this.db.query(
        `
        update import_batches
        set valid_rows = 0,
            rejected_rows = $2,
            import_status = 'FAILED',
            notes = $3
        where id = $1
        `,
        [batchId, rows.length, String(error?.message || 'Import failed')]
      );
      throw error;
    } finally {
      await runner.release();
    }

    await this.db.query(
      `
      update import_batches
      set valid_rows = $2,
          rejected_rows = 0,
          import_status = 'IMPORTED',
          notes = null
      where id = $1
      `,
      [batchId, rows.length]
    );

    try {
      const postImport = await this.runPostImportSync(tenantId, user?.id || `import:${batchId}`);
      await this.db.query(
        `
        update import_batches
        set import_status = 'COMPLETED',
            notes = $2
        where id = $1
        `,
        [batchId, `signal_run=${postImport.signalRunId}`]
      );
    } catch (postError: any) {
      await this.db.query(
        `
        update import_batches
        set import_status = 'FAILED',
            notes = $2
        where id = $1
        `,
        [batchId, `post_import_failed: ${String(postError?.message || 'unknown error')}`]
      );
      throw postError;
    }

    return {
      batchId,
      status: 'COMPLETED',
      totalRows: rows.length,
      validRows: rows.length,
      rejectedRows: 0,
      errors: []
    };
  }

  async getImportById(user: IAuthUser | undefined, importId: number) {
    const tenantId = await this.resolveTenantId(user);
    const rows = await this.db.query(`select * from import_batches where id = $1 and tenant_id = $2 limit 1`, [importId, tenantId]);
    if (!rows.length) {
      throw new Error('Import not found');
    }
    return rows[0];
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

  async getObserveSummary(user?: IAuthUser) {
    const tenantId = await this.resolveTenantId(user);
    const latestDate = await this.latestSnapshotDate(tenantId);
    if (!latestDate) {
      return {
        period: { label: 'MTD', dayElapsed: 0, daysInPeriod: 0, quarter: '-' },
        summarySection: { metricCards: [], goals: [], periodIntelligence: [], entityPulseCards: [] },
        intelligence: []
      };
    }

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
      select id, signal_key, severity, headline, description
      from entity_signals
      where tenant_id = $1
      order by detected_at desc
      limit 10
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
    const latestDateParts = getDateParts(latestDate);

    return {
      period: {
        label: 'MTD',
        dayElapsed: latestDateParts.day,
        daysInPeriod: latestDateParts.daysInMonth,
        quarter: `Q${latestDateParts.quarter}`
      },
      summarySection: {
        metricCards: [
          {
            key: 'revenue',
            title: 'GMV',
            value: Number(summaryMap.gmv || 0).toLocaleString('en-IN'),
            subtitle: 'Gross merchandise value',
            note: `${Number(summaryMap.gmv || 0).toFixed(0)}`,
            accent: '#4463ea'
          },
          {
            key: 'collection',
            title: 'Collections',
            value: Number(summaryMap.collections || 0).toLocaleString('en-IN'),
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
            key: 'orders',
            title: 'Orders',
            value: Number(summaryMap.orders || 0).toLocaleString('en-IN'),
            subtitle: 'Orders in period',
            note: `${Number(summaryMap.orders || 0).toFixed(0)}`,
            accent: '#1d4ed8'
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
      intelligence: signals
    };
  }

  async listObserveEntity(entityType: string, user?: IAuthUser, query?: { limit?: number; page?: number; timeRange?: string }) {
    const tenantId = await this.resolveTenantId(user);
    const snapshotDate = await this.resolveCompareSnapshotDate(tenantId, query?.timeRange);
    if (!snapshotDate) {
      return { data: [], meta: { page: 1, limit: 0, total: 0, totalPages: 0 } };
    }

    const metricSets: Record<string, string[]> = {
      salesman: ['revenue_mtd', 'collection_mtd', 'orders_mtd', 'coverage_pct', 'beat_adherence_pct', 'outstanding', 'mtd_outstanding'],
      retailer: ['revenue_mtd', 'orders_mtd', 'aov', 'outstanding', 'mtd_outstanding', 'dormancy_days'],
      beat: ['revenue_mtd', 'coverage_pct', 'realization_pct', 'visits_mtd', 'ebv', 'outstanding', 'mtd_outstanding'],
      sku: ['revenue_mtd', 'units_mtd', 'penetration_pct', 'growth_pct', 'outlets_mtd'],
      distributor: ['revenue_mtd', 'orders_mtd', 'outstanding', 'mtd_outstanding', 'fulfilment_pct', 'damage_pct'],
      geography: ['revenue_mtd', 'collection_mtd', 'orders_mtd', 'coverage_pct']
    };
    const metrics = metricSets[entityType] || ['revenue_mtd'];

    const rows = await this.db.query(
      `
      select
        entity_id, max(entity_name) as entity_name, max(zone) as zone, max(region) as region, max(area) as area,
        ${metrics.map((metric, index) => `max(case when metric_key = '${metric}' then metric_value end) as m_${index}`).join(',')}
      from entity_metric_snapshots
      where tenant_id = $1
        and entity_type = $2
        and snapshot_date = $3::date
      group by entity_id
      order by max(entity_name) asc
      `,
      [tenantId, entityType, snapshotDate]
    );

    const mapped = rows.map((row: any) => {
      const map: Record<string, unknown> = {
        id: String(row.entity_id),
        name: row.entity_name,
        zone: row.zone,
        region: row.region,
        area: row.area
      };
      metrics.forEach((metric, index) => {
        map[metric] = Number(row[`m_${index}`] || 0);
      });

      if (entityType === 'salesman') {
        return {
          ...map,
          salesmanId: map.id,
          firstName: String(map.name || '').split(' ')[0] || map.name,
          lastName: String(map.name || '').split(' ').slice(1).join(' '),
          revenue: map.revenue_mtd,
          collection: map.collection_mtd,
          orders: map.orders_mtd,
          coverage: map.coverage_pct,
          beatAdherence: map.beat_adherence_pct,
          outstanding: map.outstanding,
          mtdOutstanding: map.mtd_outstanding
        };
      }
      if (entityType === 'retailer') {
        return {
          ...map,
          retailerId: map.id,
          firstName: map.name,
          lastName: '',
          revenue: map.revenue_mtd,
          orders: map.orders_mtd,
          aov: map.aov,
          outstanding: map.outstanding,
          mtdOutstanding: map.mtd_outstanding,
          dormancyDays: map.dormancy_days
        };
      }
      if (entityType === 'beat') {
        return {
          ...map,
          beatId: map.id,
          beatName: map.name,
          revenue: map.revenue_mtd,
          coverage: map.coverage_pct,
          realizationPct: map.realization_pct,
          orders: map.visits_mtd,
          ebv: map.ebv,
          outstanding: map.outstanding,
          mtdOutstanding: map.mtd_outstanding
        };
      }
      if (entityType === 'sku') {
        return {
          ...map,
          skuId: map.id,
          skuName: map.name,
          revenue: map.revenue_mtd,
          qty: map.units_mtd,
          penetration: map.penetration_pct,
          growth: map.growth_pct
        };
      }
      if (entityType === 'distributor') {
        return {
          ...map,
          distributorId: map.id,
          distributorName: map.name,
          revenue: map.revenue_mtd,
          orders: map.orders_mtd,
          outstanding: map.outstanding,
          mtdOutstanding: map.mtd_outstanding,
          fulfilmentRate: map.fulfilment_pct,
          damage: map.damage_pct
        };
      }
      if (entityType === 'geography') {
        return {
          ...map,
          revenue: map.revenue_mtd,
          collection: map.collection_mtd,
          orders: map.orders_mtd,
          coverage: map.coverage_pct
        };
      }
      return map;
    });

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
        totalPages: mapped.length ? Math.ceil(mapped.length / limit) : 1
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
    }>
  ) {
    const tenantId = await this.resolveTenantId(user);
    for (const item of overrides) {
      const signalDefinitionId = await this.resolveSignalDefinitionId(tenantId, item);
      const zone = this.normalizeZone(item.zone);
      await this.db.query(
        `
          insert into tenant_signal_thresholds (tenant_id, signal_definition_id, zone, threshold_value, is_enabled)
          values ($1,$2,$3,$4,$5)
          on conflict (tenant_id, signal_definition_id, zone)
          do update set threshold_value = excluded.threshold_value, is_enabled = excluded.is_enabled, updated_at = now()
        `,
        [tenantId, signalDefinitionId, zone, item.thresholdValue, item.isEnabled ?? true]
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
