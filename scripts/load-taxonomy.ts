import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import AppDataSource from '../src/db/data-source';
import { buildSemanticRefreshRecords } from '../src/lib/fmcg-taxonomy';
import { ensureAskCatalogSchema, insertSemanticRecords, type TenantCatalogTarget } from '../src/lib/catalog-refresh';

type CliArgs = {
  tenantId: number;
  sourcePath?: string;
  refreshId: string;
};

type QueryableDataSource = {
  query: (query: string, parameters?: unknown[]) => Promise<any[]>;
};

export function parseArgs(argv: string[]): CliArgs {
  let tenantId: number | null = null;
  let sourcePath = '';
  let refreshId = '';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--tenant-id' && next) {
      tenantId = Number(next);
      index += 1;
      continue;
    }
    if (arg === '--file' && next) {
      sourcePath = next;
      index += 1;
      continue;
    }
    if (arg === '--refresh-id' && next) {
      refreshId = next;
      index += 1;
      continue;
    }
  }

  if (!tenantId || Number.isNaN(tenantId)) {
    throw new Error('Missing required --tenant-id <number>');
  }
  return {
    tenantId,
    sourcePath: sourcePath || undefined,
    refreshId: refreshId || randomUUID()
  };
}

async function resolveTenantTarget(db: QueryableDataSource, tenantId: number): Promise<TenantCatalogTarget> {
  const rows = await db.query('select id, tenant_code from tenants where id = $1 limit 1', [tenantId]);
  if (!rows.length) {
    throw new Error(`Tenant ${tenantId} not found`);
  }
  return {
    id: Number(rows[0].id),
    tenantCode: String(rows[0].tenant_code)
  };
}

export async function loadTaxonomyToDatabase(
  db: QueryableDataSource,
  args: CliArgs,
  persistSemanticRecords: typeof insertSemanticRecords = insertSemanticRecords
): Promise<ReturnType<typeof buildSemanticRefreshRecords>> {
  const tenant = await resolveTenantTarget(db, args.tenantId);
  const relationshipRows = await db.query(
      `
      select from_table as "fromTable",
             from_column as "fromColumn",
             to_table as "toTable",
             to_column as "toColumn",
             relationship_type as "relationshipType",
             cardinality,
             source
      from ask_catalog_relationships
      where tenant_id = $1
      order by from_table asc, to_table asc, from_column asc, to_column asc
      `,
      [tenant.id]
  );
  const records = buildSemanticRefreshRecords(tenant, args.refreshId, args.sourcePath, relationshipRows);
  await persistSemanticRecords(db as never, tenant.id, records);
  return records;
}

async function loadTaxonomy(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await AppDataSource.initialize();
  try {
    await ensureAskCatalogSchema(AppDataSource);
    const tenant = await resolveTenantTarget(AppDataSource, args.tenantId);
    const records = await loadTaxonomyToDatabase(AppDataSource, args);
    console.log(
      JSON.stringify(
        {
          tenantId: tenant.id,
          tenantCode: tenant.tenantCode,
          semanticPackVersionId: records.semanticPackVersion.id,
          refreshId: args.refreshId,
          sourcePath: records.semanticPack.sourcePath,
          counts: {
            clusters: records.clusters.length,
            canonicalQuestions: records.canonicalQuestions.length,
            questionVariants: records.questionVariants.length,
            entities: records.entities.length,
            metrics: records.metrics.length,
            metricAliases: records.metricAliases.length,
            joinPolicies: records.joinPolicies.length,
            datePolicies: records.datePolicies.length,
            thresholdPolicies: records.thresholdPolicies.length
          }
        },
        null,
        2
      )
    );
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadTaxonomy().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
