import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { env } from '../src/config/env';
import { SupeV1Service, ORDERS_BOOK_HEADERS } from '../src/modules/v1/service';

type QueryCall = {
  sql: string;
  params: any[];
};

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function buildValidOrdersBookValues(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'S.no': '1',
    'distributors.distributor_code': 'D001',
    'distributors.distributor_name': 'Distributor One',
    'distributors.zone': 'North',
    'distributors.region': 'Delhi NCR',
    'distributors.area': 'Noida',
    'beats.beat_code': 'B001',
    'beats.beat_name': 'Beat One',
    'salesmen.salesman_code': 'S001',
    'salesmen.salesman_name': 'Salesman One',
    'salesmen.employee_code': 'EMP001',
    'salesmen.external_salesman_id': 'EXT-S001',
    'salesmen.phone_number': '9876543210',
    'salesmen.zone': 'North',
    'salesmen.region': 'Delhi NCR',
    'salesmen.area': 'Noida',
    'outlets.external_outlet_code': 'OUT001',
    'outlets.outlet_name': 'Outlet One',
    'outlets.mobile_number': '9876543211',
    'outlets.gst_number': 'GST123',
    'outlets.address_line1': 'Addr 1',
    'outlets.address_line2': 'Addr 2',
    'outlets.pincode': '201301',
    'outlets.latitude': '28.5355',
    'outlets.longitude': '77.3910',
    'outlets.zone': 'North',
    'outlets.region': 'Delhi NCR',
    'outlets.area': 'Noida',
    'tenant_outlets.tenant_outlet_code': 'TOUT001',
    'brands.brand_code': 'BR001',
    'brands.brand_name': 'Brand One',
    'skus.sku_code': 'SKU001',
    'skus.name': 'SKU One',
    'skus.hsn_code': 'HSN001',
    'skus.mrp': '120',
    'skus.discount_amount': '5',
    'skus.discount_percent': '4.17',
    'skus.weight': '1',
    'skus.length_cm': '10',
    'skus.width_cm': '5',
    'skus.height_cm': '3',
    'skus.rate': '100',
    'skus.sgst_percent': '9',
    'skus.sgst_amount': '9',
    'skus.cgst_percent': '9',
    'skus.cgst_amount': '9',
    'skus.amount': '118',
    'skus.igst_percent': '0',
    'skus.igst_amount': '0',
    'sales_orders.external_order_id': 'ORD001',
    'sales_orders.external_invoice_no': 'INV001',
    'sales_orders.external_awb_no': 'AWB001',
    'sales_orders.order_punched_at': '2026-04-01T10:00:00.000Z',
    'sales_orders.order_sale_date': '2026-04-01',
    'sales_orders.gross_amount': '120',
    'sales_orders.discount_amount': '5',
    'sales_orders.tax_amount': '18',
    'sales_orders.net_amount': '133',
    'sales_orders.collections_amount': '100',
    'sales_orders.outstanding_amount': '33',
    'sales_orders.decided_margin_amount': '12',
    'sales_orders.remarks': 'Test import',
    'sales_order_items.external_line_id': 'LINE001',
    'sales_order_items.ordered_quantity': '2',
    'sales_order_items.rate': '50',
    'sales_order_items.discount_amount': '5',
    'sales_order_items.discount_percent': '5',
    'sales_order_items.sgst_percent': '9',
    'sales_order_items.sgst_amount': '9',
    'sales_order_items.cgst_percent': '9',
    'sales_order_items.cgst_amount': '9',
    'sales_order_items.igst_percent': '0',
    'sales_order_items.igst_amount': '0',
    'sales_order_items.tax_amount': '18',
    'sales_order_items.amount': '113',
    'order_payments.payment_date': '2026-04-02',
    'order_payments.payment_mode': 'cash',
    'order_payments.amount': '100',
    'order_payments.external_ref': 'PAY001',
    ...overrides
  };
}

function buildValidOrdersBookRow(overrides: Record<string, unknown> = {}) {
  const values = buildValidOrdersBookValues(overrides);
  return Object.fromEntries(ORDERS_BOOK_HEADERS.map((header) => [header, values[header] ?? '']));
}

function buildWorkbookBuffer(overrides: Record<string, unknown> = {}): Buffer {
  const values = buildValidOrdersBookValues(overrides);
  const worksheet = XLSX.utils.aoa_to_sheet([
    [...ORDERS_BOOK_HEADERS],
    ORDERS_BOOK_HEADERS.map((header) => values[header] ?? '')
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'orders_book');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function createQueryRunner(handler: (sql: string, params?: any[]) => Promise<any[]> | any[]) {
  return {
    connect: async () => {},
    startTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    release: async () => {},
    query: async (sql: string, params?: any[]) => handler(sql, params)
  };
}

test('createImport queues a valid workbook', async () => {
  const previousBucket = env.S3_BUCKET;
  env.S3_BUCKET = 'test-import-bucket';
  const service = new SupeV1Service({} as any);
  const internal = service as any;
  let uploadedArgs: any[] | null = null;
  let batchPayload: Record<string, unknown> | null = null;

  internal.resolveTenantId = async () => 42;
  internal.resolveTenantCode = () => 'tenant-42';
  internal.uploadToS3 = async (...args: any[]) => {
    uploadedArgs = args;
    return 'imports/tenant-42/orders.xlsx';
  };
  internal.createImportBatchRecord = async (payload: Record<string, unknown>) => {
    batchPayload = payload;
    return 99;
  };

  try {
    const result = await service.createImport(undefined, {
      filename: 'orders.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      toBuffer: async () => buildWorkbookBuffer()
    });

    assert.deepEqual(result, {
      batchId: 99,
      status: 'QUEUED',
      totalRows: 0,
      totalColumns: ORDERS_BOOK_HEADERS.length
    });
    assert.equal(uploadedArgs?.[0], 'tenant-42');
    assert.equal(uploadedArgs?.[1], 'orders.xlsx');
    assert.equal(uploadedArgs?.[3], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.ok(Buffer.isBuffer(uploadedArgs?.[2]));
    assert.equal(Buffer.compare(Buffer.from(uploadedArgs?.[2] || []), buildWorkbookBuffer()), 0);
    assert.equal(batchPayload?.importStatus, 'QUEUED');
    assert.equal(batchPayload?.fileObjectKey, 'imports/tenant-42/orders.xlsx');
  } finally {
    env.S3_BUCKET = previousBucket;
  }
});

test('persistOrdersBookRows touches the canonical tables for a valid row', async () => {
  const calls: QueryCall[] = [];
  const runner = createQueryRunner((sql: string, params?: any[]) => {
    calls.push({ sql, params: params || [] });
    const normalized = normalizeSql(sql);
    if (normalized.includes('insert into raw_records')) return [{ id: 1 }];
    if (normalized.includes('insert into distributors')) return [{ id: 11 }];
    if (normalized.includes('insert into beats')) return [{ id: 12 }];
    if (normalized.includes('insert into salesmen')) return [{ id: 13 }];
    if (normalized.includes('select to2.id as tenant_outlet_id')) return [];
    if (normalized.includes('insert into outlets')) return [{ id: 14 }];
    if (normalized.startsWith('update outlets')) return [];
    if (normalized.includes('insert into tenant_outlets')) return [{ id: 15 }];
    if (normalized.startsWith('update beat_outlets')) return [];
    if (normalized.includes('insert into beat_outlets')) return [];
    if (normalized.includes('select id from brands where tenant_id = $1 and brand_code')) return [];
    if (normalized.includes('select id from brands where tenant_id = $1 and lower(brand_name)')) return [];
    if (normalized.includes('insert into brands')) return [{ id: 16 }];
    if (normalized.includes('insert into skus')) return [{ id: 17 }];
    if (normalized.includes('select id from sales_orders where tenant_id = $1 and external_invoice_no')) return [];
    if (normalized.includes('insert into sales_orders')) return [{ id: 18 }];
    if (normalized.includes('insert into canonical_record_sources')) return [];
    if (normalized.includes('insert into sales_order_items')) return [{ id: 19 }];
    if (normalized.includes('select id from order_payments where tenant_id = $1 and sales_order_id = $2 and external_ref')) return [];
    if (normalized.includes('insert into order_payments')) return [{ id: 20 }];
    return [];
  });

  const db = {
    createQueryRunner: () => runner
  };
  const service = new SupeV1Service(db as any);

  await (service as any).persistOrdersBookRows(42, 7, [buildValidOrdersBookRow()]);

  const seenSql = calls.map((call) => normalizeSql(call.sql));
  const expectedTables = [
    'insert into raw_records',
    'insert into distributors',
    'insert into beats',
    'insert into salesmen',
    'insert into outlets',
    'insert into tenant_outlets',
    'insert into beat_outlets',
    'insert into brands',
    'insert into skus',
    'insert into sales_orders',
    'insert into sales_order_items',
    'insert into order_payments',
    'insert into canonical_record_sources'
  ];

  for (const fragment of expectedTables) {
    assert.ok(seenSql.some((sql) => sql.includes(fragment)), `expected query containing "${fragment}"`);
  }
});

test('persistOrdersBookRows updates existing line items without relying on on conflict', async () => {
  const calls: QueryCall[] = [];
  const runner = createQueryRunner((sql: string, params?: any[]) => {
    calls.push({ sql, params: params || [] });
    const normalized = normalizeSql(sql);
    if (normalized.includes('insert into raw_records')) return [{ id: 1 }];
    if (normalized.includes('insert into distributors')) return [{ id: 11 }];
    if (normalized.includes('insert into beats')) return [{ id: 12 }];
    if (normalized.includes('insert into salesmen')) return [{ id: 13 }];
    if (normalized.includes('select to2.id as tenant_outlet_id')) return [];
    if (normalized.includes('insert into outlets')) return [{ id: 14 }];
    if (normalized.startsWith('update outlets')) return [];
    if (normalized.includes('insert into tenant_outlets')) return [{ id: 15 }];
    if (normalized.startsWith('update beat_outlets')) return [];
    if (normalized.includes('insert into beat_outlets')) return [];
    if (normalized.includes('select id from brands where tenant_id = $1 and brand_code')) return [];
    if (normalized.includes('select id from brands where tenant_id = $1 and lower(brand_name)')) return [];
    if (normalized.includes('insert into brands')) return [{ id: 16 }];
    if (normalized.includes('insert into skus')) return [{ id: 17 }];
    if (normalized.includes('select id from sales_orders where tenant_id = $1 and external_invoice_no')) return [{ id: 18 }];
    if (normalized.startsWith('update sales_orders')) return [];
    if (normalized.includes('insert into canonical_record_sources')) return [];
    if (normalized.includes('select id from sales_order_items where sales_order_id = $1 and external_line_id = $2')) return [{ id: 19 }];
    if (normalized.startsWith('update sales_order_items')) return [];
    return [];
  });

  const db = {
    createQueryRunner: () => runner
  };
  const service = new SupeV1Service(db as any);

  await (service as any).persistOrdersBookRows(42, 7, [
    buildValidOrdersBookRow({
      'order_payments.amount': ''
    })
  ]);

  const seenSql = calls.map((call) => normalizeSql(call.sql));
  assert.ok(
    seenSql.some((sql) => sql.startsWith('update sales_order_items')),
    'expected existing line item update'
  );
  assert.ok(
    !seenSql.some((sql) => sql.includes('insert into sales_order_items')),
    'expected no sales_order_items insert when the line already exists'
  );
  assert.ok(
    !seenSql.some((sql) => sql.includes('on conflict (sales_order_id, external_line_id)')),
    'expected no on conflict usage for sales_order_items'
  );
});

test('refreshTenantState runs analytics-derived refresh before catalog refresh', async () => {
  const db = {
    query: async (sql: string) => {
      if (normalizeSql(sql).includes('select id, tenant_code from tenants')) {
        return [{ id: 42, tenant_code: 'tenant-42' }];
      }
      return [];
    },
    createQueryRunner: () => createQueryRunner(() => [])
  };

  const service = new SupeV1Service(db as any);
  const internal = service as any;
  const steps: string[] = [];

  internal.seedStaticData = async () => {
    steps.push('seed');
  };
  internal.refreshSnapshots = async () => {
    steps.push('snapshots');
  };
  internal.evaluateSignalsInternal = async () => {
    steps.push('signals');
    return 77;
  };
  internal.recomputeTargetProgressInternal = async () => {
    steps.push('targets');
  };
  internal.refreshCatalogState = async () => {
    steps.push('catalog');
    return {
      refreshedTables: 3,
      refreshedColumns: 4,
      refreshedRelationships: 5,
      refreshedAliases: 6
    };
  };

  const result = await service.refreshTenantState(42, 'worker-1');

  assert.deepEqual(steps, ['seed', 'snapshots', 'signals', 'targets', 'catalog']);
  assert.deepEqual(result, {
    signalRunId: 77,
    catalog: {
      refreshedTables: 3,
      refreshedColumns: 4,
      refreshedRelationships: 5,
      refreshedAliases: 6
    }
  });
});

test('processNextQueuedImport completes only after shared refresh succeeds', async () => {
  const calls: QueryCall[] = [];
  const db = {
    query: async (sql: string, params?: any[]) => {
      calls.push({ sql, params: params || [] });
      const normalized = normalizeSql(sql);
      if (normalized.includes('with candidate as')) {
        return [{ id: 77 }];
      }
      if (normalized.includes("select * from import_batches where id = $1 limit 1")) {
        return [
          {
            id: 77,
            tenant_id: 42,
            source_file_name: 'orders.xlsx',
            source_file_type: 'xlsx',
            source_sheet_name: 'orders_book',
            file_checksum: 'abc',
            file_object_key: 'imports/tenant-42/orders.xlsx',
            total_rows: 1,
            total_columns: ORDERS_BOOK_HEADERS.length,
            valid_rows: 0,
            rejected_rows: 0,
            error_count: 0,
            import_status: 'QUEUED',
            notes: null,
            started_at: null,
            completed_at: null,
            processed_by: null,
            imported_at: '2026-04-03T00:00:00.000Z',
            created_at: '2026-04-03T00:00:00.000Z'
          }
        ];
      }
      return [];
    }
  };

  const service = new SupeV1Service(db as any);
  const internal = service as any;
  let persistedRows: any[] = [];
  let refreshCalled = false;

  internal.downloadFromS3 = async () => buildWorkbookBuffer();
  internal.persistOrdersBookRows = async (_tenantId: number, _batchId: number, rows: any[]) => {
    persistedRows = rows;
  };
  internal.refreshTenantState = async () => {
    refreshCalled = true;
    return {
      signalRunId: 55,
      catalog: {
        refreshedTables: 10,
        refreshedColumns: 20,
        refreshedRelationships: 5,
        refreshedAliases: 7
      }
    };
  };

  const result = await service.processNextQueuedImport('worker-1');

  assert.equal(result, true);
  assert.equal(persistedRows.length, 1);
  assert.equal(refreshCalled, true);

  const normalizedQueries = calls.map((call) => normalizeSql(call.sql));
  const importedUpdateIndex = normalizedQueries.findIndex(
    (sql) => sql.includes("set total_rows = $2") && sql.includes("notes = 'refresh_tenant_state'")
  );
  const completedUpdateIndex = normalizedQueries.findIndex((sql) => sql.includes("set import_status = 'completed'"));
  assert.ok(importedUpdateIndex >= 0, 'expected imported status update');
  assert.ok(completedUpdateIndex > importedUpdateIndex, 'expected completed status update after imported status update');
  const intermediateCall = calls[importedUpdateIndex];
  assert.equal(intermediateCall.params[0], 77);
  assert.equal(intermediateCall.params[1], 1);
  assert.equal(intermediateCall.params[2], ORDERS_BOOK_HEADERS.length);
  assert.match(String(intermediateCall.sql), /import_status = 'PROCESSING'/);
  assert.match(String(intermediateCall.sql), /notes = 'refresh_tenant_state'/);
  const completedCall = calls[completedUpdateIndex];
  assert.match(String(completedCall.params[1]), /signal_run=55/);
  assert.match(String(completedCall.params[1]), /catalog_tables=10/);
});

test('processNextQueuedImport tolerates raw driver update-return shapes', async () => {
  const calls: QueryCall[] = [];
  const db = {
    query: async (sql: string, params?: any[]) => {
      calls.push({ sql, params: params || [] });
      const normalized = normalizeSql(sql);
      if (normalized.includes('with candidate as')) {
        return [[{ id: '79' }], 1];
      }
      if (normalized.includes("select * from import_batches where id = $1 limit 1")) {
        return [
          {
            id: 79,
            tenant_id: 42,
            source_file_name: 'orders.xlsx',
            source_file_type: 'xlsx',
            source_sheet_name: 'orders_book',
            file_checksum: 'abc',
            file_object_key: 'imports/tenant-42/orders.xlsx',
            total_rows: 1,
            total_columns: ORDERS_BOOK_HEADERS.length,
            valid_rows: 0,
            rejected_rows: 0,
            error_count: 0,
            import_status: 'QUEUED',
            notes: null,
            started_at: null,
            completed_at: null,
            processed_by: null,
            imported_at: '2026-04-03T00:00:00.000Z',
            created_at: '2026-04-03T00:00:00.000Z'
          }
        ];
      }
      return [];
    }
  };

  const service = new SupeV1Service(db as any);
  const internal = service as any;
  internal.downloadFromS3 = async () => buildWorkbookBuffer();
  internal.persistOrdersBookRows = async () => {};
  internal.refreshTenantState = async () => ({
    signalRunId: 56,
    catalog: {
      refreshedTables: 2,
      refreshedColumns: 3,
      refreshedRelationships: 4,
      refreshedAliases: 5
    }
  });

  const result = await service.processNextQueuedImport('worker-variant');

  assert.equal(result, true);
  const phaseNoteCall = calls.find(
    (call) =>
      normalizeSql(call.sql) === 'update import_batches set notes = $2 where id = $1' &&
      call.params[0] === 79 &&
      call.params[1] === 'claimed'
  );
  assert.ok(phaseNoteCall, 'expected claimed phase note update for nested update-return shape');
});

test('processNextQueuedImport marks the batch failed when shared refresh fails after persistence', async () => {
  const calls: QueryCall[] = [];
  const db = {
    query: async (sql: string, params?: any[]) => {
      calls.push({ sql, params: params || [] });
      const normalized = normalizeSql(sql);
      if (normalized.includes('with candidate as')) {
        return [{ id: 88 }];
      }
      if (normalized.includes("select * from import_batches where id = $1 limit 1")) {
        return [
          {
            id: 88,
            tenant_id: 42,
            source_file_name: 'orders.xlsx',
            source_file_type: 'xlsx',
            source_sheet_name: 'orders_book',
            file_checksum: 'abc',
            file_object_key: 'imports/tenant-42/orders.xlsx',
            total_rows: 1,
            total_columns: ORDERS_BOOK_HEADERS.length,
            valid_rows: 0,
            rejected_rows: 0,
            error_count: 0,
            import_status: 'QUEUED',
            notes: null,
            started_at: null,
            completed_at: null,
            processed_by: null,
            imported_at: '2026-04-03T00:00:00.000Z',
            created_at: '2026-04-03T00:00:00.000Z'
          }
        ];
      }
      return [];
    }
  };

  const service = new SupeV1Service(db as any);
  const internal = service as any;
  internal.downloadFromS3 = async () => buildWorkbookBuffer();
  internal.persistOrdersBookRows = async () => {};
  internal.refreshTenantState = async () => {
    throw new Error('catalog refresh failed');
  };

  await assert.rejects(() => service.processNextQueuedImport('worker-2'), /catalog refresh failed/);

  const errorInsert = calls.find((call) => normalizeSql(call.sql).includes('insert into import_batch_errors'));
  assert.ok(errorInsert, 'expected import batch error insert');
  assert.equal(errorInsert?.params[5], 'post_import');

  const failedUpdate = calls.find((call) => normalizeSql(call.sql).includes("set valid_rows = 0"));
  assert.ok(failedUpdate, 'expected failed batch status update');
  assert.equal(failedUpdate?.params[3], 'post_import_failed: catalog refresh failed');
});

test('failImportBatch still marks the batch failed when error detail persistence fails', async () => {
  const calls: QueryCall[] = [];
  const db = {
    query: async (sql: string, params?: any[]) => {
      calls.push({ sql, params: params || [] });
      if (normalizeSql(sql).includes('insert into import_batch_errors')) {
        throw new Error('detail insert failed');
      }
      return [];
    }
  };

  const service = new SupeV1Service(db as any);

  await (service as any).failImportBatch(
    91,
    'Import validation failed',
    [{ sNo: '1', rowNumber: 2, column: 'sku', message: 'bad sku' }],
    'validation',
    1
  );

  const failedUpdate = calls.find((call) => normalizeSql(call.sql).includes("set valid_rows = 0"));
  assert.ok(failedUpdate, 'expected failed batch status update');
  assert.equal(failedUpdate?.params[0], 91);
  assert.equal(failedUpdate?.params[1], 1);
  assert.equal(failedUpdate?.params[2], 1);
  assert.match(String(failedUpdate?.params[3]), /error details unavailable/);
});

test('sweepStuckImports only auto-fails processing batches', async () => {
  const calls: QueryCall[] = [];
  const db = {
    query: async (sql: string, params?: any[]) => {
      calls.push({ sql, params: params || [] });
      return [[{ id: 101 }], 1];
    }
  };

  const service = new SupeV1Service(db as any);
  const count = await service.sweepStuckImports(15);

  assert.equal(count, 1);
  assert.equal(calls.length, 1);
  assert.match(String(calls[0].sql), /where import_status = 'PROCESSING'/);
  assert.doesNotMatch(String(calls[0].sql), /IMPORTED/);
});

test('cancelImport treats nested update-return shape with zero rows as not found', async () => {
  const db = {
    query: async () => [[/* rows */], 0]
  };

  const service = new SupeV1Service(db as any);
  const internal = service as any;
  internal.resolveTenantId = async () => 42;

  await assert.rejects(() => service.cancelImport(undefined, 999), /Import not found or already in a terminal state/);
});
