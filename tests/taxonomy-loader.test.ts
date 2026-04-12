import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTaxonomyToDatabase, parseArgs } from '../scripts/load-taxonomy';
import { refreshCatalogForTenant } from '../src/lib/catalog-refresh';

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

test('parseArgs requires tenant id and uses the committed taxonomy artifact by default', () => {
  assert.throws(() => parseArgs([]), /tenant-id/);

  const parsed = parseArgs(['--tenant-id', '12', '--refresh-id', 'refresh-1']);
  assert.equal(parsed.tenantId, 12);
  assert.equal(parsed.sourcePath, undefined);
  assert.equal(parsed.refreshId, 'refresh-1');
});

test('loadTaxonomyToDatabase builds semantic records and persists them for a tenant', async () => {
  const db = {
    async query(sql: string, params?: unknown[]) {
      const normalized = normalizeSql(sql);
      if (normalized.includes('select id, tenant_code from tenants')) {
        return [{ id: 12, tenant_code: 'tenant-12' }];
      }
      if (normalized.includes('from ask_catalog_relationships')) {
        assert.deepEqual(params, [12]);
        return [
          {
            fromTable: 'sales_orders',
            fromColumn: 'salesman_id',
            toTable: 'salesmen',
            toColumn: 'id',
            relationshipType: 'foreign_key',
            cardinality: 'many_to_one',
            source: 'database'
          }
        ];
      }
      return [];
    }
  };
  const persisted: Array<{ tenantId: number; records: any }> = [];

  const records = await loadTaxonomyToDatabase(
    db,
    { tenantId: 12, refreshId: 'refresh-1' },
    async (_db, tenantId, semanticRecords) => {
      persisted.push({ tenantId, records: semanticRecords });
    }
  );

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].tenantId, 12);
  assert.equal(records.semanticPackVersion.refreshId, 'refresh-1');
  assert.match(records.semanticPack.sourcePath, /fmcg-taxonomy\.compiled\.json$/);
  assert.equal(records.clusters.length, 20);
  assert.equal(records.canonicalQuestions.length, 452);
  assert.ok(records.questionVariants.length > 200);
  assert.equal(records.datePolicies.length, 1);
  assert.equal(records.joinPolicies.length, 1);
});

test('refreshCatalogForTenant fails when semantic-pack readiness is missing', async () => {
  const calls: string[] = [];
  const db = {
    async query(sql: string) {
      calls.push(sql);
      const normalized = normalizeSql(sql);
      if (normalized.includes('from information_schema.columns')) {
        return [];
      }
      return [];
    },
    createQueryRunner() {
      return {
        connect: async () => {},
        startTransaction: async () => {},
        commitTransaction: async () => {},
        rollbackTransaction: async () => {},
        release: async () => {},
        query: async (sql: string) => {
          calls.push(sql);
          return [];
        }
      };
    }
  };

  await assert.rejects(
    () => refreshCatalogForTenant(db as any, { id: 12, tenantCode: 'tenant-12' }, 'tester'),
    /semantic pack version missing after catalog refresh/
  );
  assert.equal(calls.some((sql) => normalizeSql(sql).includes('update ask_catalog_refreshes set status = \'failed\'')), true);
});
