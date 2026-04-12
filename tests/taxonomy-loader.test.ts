import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTaxonomyToDatabase, parseArgs } from '../scripts/load-taxonomy';
import { refreshCatalogForTenant } from '../src/lib/catalog-refresh';

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function writeFixtureTaxonomy(): string {
  const fixturePath = path.join(os.tmpdir(), `taxonomy-${Date.now()}.md`);
  const content = `# 3. Master Question Taxonomy

### CLUSTER 1: Revenue & Billing Performance (1 questions)
| # | Canonical Question | Source | Level | Entity |
| 1 | What is my total secondary revenue MTD? | sales_orders | basic | Salesman |

# 4. Natural Language Variant Library

**Q1: What is my total secondary revenue MTD?**
1. Show billing MTD by salesman
2. Revenue this month for each salesman
`;
  fs.writeFileSync(fixturePath, content, 'utf8');
  return fixturePath;
}

test('parseArgs requires tenant id and taxonomy file', () => {
  assert.throws(() => parseArgs([]), /tenant-id/);
  assert.throws(() => parseArgs(['--tenant-id', '12']), /--file/);

  const parsed = parseArgs(['--tenant-id', '12', '--file', '/tmp/taxonomy.md', '--refresh-id', 'refresh-1']);
  assert.equal(parsed.tenantId, 12);
  assert.equal(parsed.sourcePath, '/tmp/taxonomy.md');
  assert.equal(parsed.refreshId, 'refresh-1');
});

test('loadTaxonomyToDatabase builds semantic records and persists them for a tenant', async () => {
  const fixturePath = writeFixtureTaxonomy();
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

  try {
    const records = await loadTaxonomyToDatabase(
      db,
      { tenantId: 12, sourcePath: fixturePath, refreshId: 'refresh-1' },
      async (_db, tenantId, semanticRecords) => {
        persisted.push({ tenantId, records: semanticRecords });
      }
    );

    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].tenantId, 12);
    assert.equal(records.semanticPackVersion.refreshId, 'refresh-1');
    assert.equal(records.semanticPack.sourcePath, fixturePath);
    assert.equal(records.clusters.length, 1);
    assert.equal(records.canonicalQuestions.length, 1);
    assert.equal(records.questionVariants.length, 2);
    assert.equal(records.datePolicies.length, 1);
    assert.equal(records.joinPolicies.length, 1);
  } finally {
    fs.unlinkSync(fixturePath);
  }
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
