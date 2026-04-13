import { randomUUID } from 'crypto';
import type { DataSource } from 'typeorm';
import { ASK_CATALOG_MANIFEST, type CatalogColumnHint, type CatalogTableHint } from './ask-catalog-manifest';
import { buildGraphSnapshot, warmGraphCache } from './ask-graph-cache';
import { buildSemanticRefreshRecords, type SemanticRefreshRecords } from './fmcg-taxonomy';

export type TenantCatalogTarget = {
  id: number;
  tenantCode: string;
};

type ColumnRow = {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  ordinal_position: number;
  is_primary_key: boolean;
  references_table: string | null;
  references_column: string | null;
};

type RelationshipRow = {
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
  relationship_type: string;
  source: string;
  cardinality: string;
};

type CatalogRecord = {
  id: string;
  tenantId: number;
  tableName: string;
  schemaName?: string;
  displayName?: string;
  description?: string;
  tenantColumn?: string | null;
  primaryKeyColumns?: string[];
  dateColumns?: string[];
  metricHints?: string[];
  dimensionHints?: string[];
  searchText: string;
  metadata?: Record<string, unknown>;
};

type CatalogColumnRecord = {
  id: string;
  tenantId: number;
  tableName: string;
  columnName: string;
  dataType: string;
  isNullable: boolean;
  ordinalPosition: number;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  referencesTable?: string | null;
  referencesColumn?: string | null;
  semanticRole?: string | null;
  description?: string | null;
  searchText: string;
  metadata?: Record<string, unknown>;
};

type CatalogRelationshipRecord = {
  id: string;
  tenantId: number;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  relationshipType: string;
  cardinality: string;
  source: string;
  searchText: string;
  metadata?: Record<string, unknown>;
};

type CatalogAliasRecord = {
  id: string;
  tenantId: number;
  objectType: string;
  objectName: string;
  tableName?: string | null;
  columnName?: string | null;
  alias: string;
  weight: number;
  source: string;
  searchText: string;
  metadata?: Record<string, unknown>;
};

export type CatalogRefreshResult = {
  refreshId: string;
  refreshedTables: number;
  refreshedColumns: number;
  refreshedRelationships: number;
  refreshedAliases: number;
  semanticPackVersionId: string;
  graphWarmed: boolean;
  askReady: boolean;
};

function titleCase(value: string): string {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
}

function buildSearchText(parts: Array<string | null | undefined>): string {
  return parts
    .flatMap((part) => String(part || '').split(/\s+/))
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function inferSemanticRole(columnName: string, dataType: string, hint?: CatalogColumnHint): string | null {
  if (hint?.semanticRole) {
    return hint.semanticRole;
  }

  const normalized = columnName.toLowerCase();
  const normalizedType = dataType.toLowerCase();
  if (normalized === 'tenant_id') {
    return 'tenant';
  }
  if (
    normalizedType.includes('date') ||
    normalizedType.includes('timestamp') ||
    normalized.endsWith('_date') ||
    normalized.endsWith('_at') ||
    normalized.includes('time')
  ) {
    return 'date';
  }
  if (normalized.endsWith('_id') || normalized === 'id' || normalized.endsWith('_code')) {
    return 'identifier';
  }
  if (
    normalized.includes('amount') ||
    normalized.includes('value') ||
    normalized.includes('count') ||
    normalized.includes('qty') ||
    normalized.includes('quantity') ||
    normalized.includes('pct') ||
    normalized.includes('percent') ||
    normalized.includes('rate') ||
    normalized.includes('price')
  ) {
    return 'metric';
  }
  if (
    normalized.includes('name') ||
    normalized.includes('type') ||
    normalized.includes('status') ||
    normalized.includes('zone') ||
    normalized.includes('region') ||
    normalized.includes('area')
  ) {
    return 'dimension';
  }
  return null;
}

function inferDateColumns(columns: ColumnRow[], hint?: CatalogTableHint): string[] {
  const explicit = hint?.canonicalDateColumns || [];
  if (explicit.length > 0) {
    return explicit;
  }
  return columns
    .filter((column) => {
      const dataType = column.data_type.toLowerCase();
      return (
        dataType.includes('date') ||
        dataType.includes('timestamp') ||
        column.column_name.endsWith('_date') ||
        column.column_name.endsWith('_at')
      );
    })
    .map((column) => column.column_name);
}

function inferTenantColumn(columns: ColumnRow[], hint?: CatalogTableHint): string | null {
  if (hint?.tenantColumn) {
    return hint.tenantColumn;
  }
  return columns.some((column) => column.column_name === 'tenant_id') ? 'tenant_id' : null;
}

function defaultTableAliases(tableName: string): string[] {
  const readable = tableName.replace(/_/g, ' ');
  const singular = readable.endsWith('s') ? readable.slice(0, -1) : readable;
  return Array.from(new Set([readable, singular, titleCase(readable), titleCase(singular)]));
}

const ENSURE_ASK_CATALOG_SCHEMA_SQL = `
create table if not exists ask_catalog_tables (
  id uuid primary key,
  tenant_id bigint not null references tenants(id),
  schema_name text not null default 'public',
  table_name text not null,
  display_name text,
  description text,
  tenant_column text,
  primary_key_columns jsonb not null default '[]'::jsonb,
  date_columns jsonb not null default '[]'::jsonb,
  metric_hints jsonb not null default '[]'::jsonb,
  dimension_hints jsonb not null default '[]'::jsonb,
  search_text text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, schema_name, table_name)
);

create index if not exists idx_ask_catalog_tables_lookup on ask_catalog_tables(tenant_id, table_name);

create table if not exists ask_catalog_columns (
  id uuid primary key,
  tenant_id bigint not null references tenants(id),
  table_name text not null,
  column_name text not null,
  data_type text not null,
  is_nullable boolean not null default true,
  ordinal_position int not null default 0,
  is_primary_key boolean not null default false,
  is_foreign_key boolean not null default false,
  references_table text,
  references_column text,
  semantic_role text,
  description text,
  search_text text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, table_name, column_name)
);

create index if not exists idx_ask_catalog_columns_lookup on ask_catalog_columns(tenant_id, table_name, column_name);

create table if not exists ask_catalog_relationships (
  id uuid primary key,
  tenant_id bigint not null references tenants(id),
  from_table text not null,
  from_column text not null,
  to_table text not null,
  to_column text not null,
  relationship_type text not null default 'foreign_key',
  cardinality text,
  source text not null default 'database',
  search_text text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, from_table, from_column, to_table, to_column, source)
);

create index if not exists idx_ask_catalog_relationships_lookup on ask_catalog_relationships(tenant_id, from_table, to_table);

create table if not exists ask_catalog_aliases (
  id uuid primary key,
  tenant_id bigint not null references tenants(id),
  object_type text not null,
  object_name text not null,
  table_name text,
  column_name text,
  alias text not null,
  weight int not null default 1,
  source text not null default 'manifest',
  search_text text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_ask_catalog_aliases_lookup on ask_catalog_aliases(tenant_id, object_type, object_name);
create index if not exists idx_ask_catalog_aliases_alias on ask_catalog_aliases(tenant_id, alias);

create table if not exists ask_catalog_refreshes (
  id uuid primary key,
  tenant_id bigint not null references tenants(id),
  status text not null,
  strategy text not null default 'catalog_refresh',
  refreshed_tables int not null default 0,
  refreshed_columns int not null default 0,
  refreshed_relationships int not null default 0,
  refreshed_aliases int not null default 0,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_ask_catalog_refreshes_lookup on ask_catalog_refreshes(tenant_id, created_at desc);

create table if not exists ask_semantic_packs (
  id uuid primary key,
  tenant_id bigint not null references tenants(id),
  source_path text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id)
);

create table if not exists ask_semantic_pack_versions (
  id uuid primary key,
  tenant_id bigint not null references tenants(id),
  semantic_pack_id uuid not null references ask_semantic_packs(id) on delete cascade,
  refresh_id uuid not null,
  source_path text not null,
  status text not null,
  cluster_count int not null default 0,
  canonical_question_count int not null default 0,
  variant_count int not null default 0,
  entity_count int not null default 0,
  metric_count int not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_ask_semantic_pack_versions_lookup on ask_semantic_pack_versions(tenant_id, created_at desc);

create table if not exists ask_question_clusters (
  id uuid primary key,
  tenant_id bigint not null references tenants(id),
  cluster_key text not null,
  cluster_number int not null,
  title text not null,
  description text not null,
  question_count int not null default 0,
  search_text text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, cluster_key)
);

create index if not exists idx_ask_question_clusters_lookup on ask_question_clusters(tenant_id, cluster_key);

create table if not exists ask_canonical_questions (
  id uuid primary key,
  tenant_id bigint not null references tenants(id),
  cluster_key text not null,
  question_number int not null,
  canonical_question text not null,
  data_sources jsonb not null default '[]'::jsonb,
  complexity text not null,
  primary_entity text not null,
  search_text text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, question_number)
);

create index if not exists idx_ask_canonical_questions_lookup on ask_canonical_questions(tenant_id, question_number);
create index if not exists idx_ask_canonical_questions_cluster on ask_canonical_questions(tenant_id, cluster_key);

create table if not exists ask_question_variants (
  id uuid primary key,
  tenant_id bigint not null references tenants(id),
  canonical_question_id uuid not null references ask_canonical_questions(id) on delete cascade,
  canonical_question_number int not null,
  variant_text text not null,
  ordinal_position int not null default 0,
  search_text text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_ask_question_variants_lookup on ask_question_variants(tenant_id, canonical_question_number);

create table if not exists ask_entities (
  id uuid primary key,
  tenant_id bigint not null references tenants(id),
  entity_key text not null,
  display_name text not null,
  aliases jsonb not null default '[]'::jsonb,
  search_text text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, entity_key)
);

create index if not exists idx_ask_entities_lookup on ask_entities(tenant_id, entity_key);

create table if not exists ask_metrics (
  id uuid primary key,
  tenant_id bigint not null references tenants(id),
  metric_key text not null,
  display_name text not null,
  aliases jsonb not null default '[]'::jsonb,
  search_text text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, metric_key)
);

create index if not exists idx_ask_metrics_lookup on ask_metrics(tenant_id, metric_key);

create table if not exists ask_metric_aliases (
  id uuid primary key,
  tenant_id bigint not null references tenants(id),
  metric_key text not null,
  alias text not null,
  weight int not null default 1,
  search_text text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_ask_metric_aliases_lookup on ask_metric_aliases(tenant_id, metric_key);
create index if not exists idx_ask_metric_aliases_alias on ask_metric_aliases(tenant_id, alias);

create table if not exists ask_join_policies (
  id uuid primary key,
  tenant_id bigint not null references tenants(id),
  policy_key text not null,
  from_table text not null,
  to_table text not null,
  via_tables jsonb not null default '[]'::jsonb,
  join_edges jsonb not null default '[]'::jsonb,
  preferred boolean not null default true,
  search_text text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, policy_key)
);

create index if not exists idx_ask_join_policies_lookup on ask_join_policies(tenant_id, from_table, to_table);

create table if not exists ask_date_policies (
  id uuid primary key,
  tenant_id bigint not null references tenants(id),
  policy_key text not null,
  metric_key text,
  date_column text not null,
  time_grains jsonb not null default '[]'::jsonb,
  timezone text not null default 'Asia/Kolkata',
  semantics text not null default 'wall_clock',
  search_text text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, policy_key)
);

create index if not exists idx_ask_date_policies_lookup on ask_date_policies(tenant_id, policy_key);

create table if not exists ask_threshold_policies (
  id uuid primary key,
  tenant_id bigint not null references tenants(id),
  policy_key text not null,
  metric_key text,
  threshold_name text not null,
  comparator text not null,
  threshold_value text,
  search_text text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, policy_key)
);

create index if not exists idx_ask_threshold_policies_lookup on ask_threshold_policies(tenant_id, policy_key);
`;

export async function ensureAskCatalogSchema(db: DataSource): Promise<void> {
  await db.query(ENSURE_ASK_CATALOG_SCHEMA_SQL);
}

async function loadColumns(db: DataSource): Promise<ColumnRow[]> {
  const rows = await db.query(
    `
    with primary_keys as (
      select
        kcu.table_schema,
        kcu.table_name,
        kcu.column_name
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on tc.constraint_name = kcu.constraint_name
       and tc.table_schema = kcu.table_schema
       and tc.table_name = kcu.table_name
      where tc.table_schema = 'public'
        and tc.constraint_type = 'PRIMARY KEY'
    ),
    foreign_keys as (
      select
        kcu.table_schema,
        kcu.table_name,
        kcu.column_name,
        ccu.table_name as references_table,
        ccu.column_name as references_column
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on tc.constraint_name = kcu.constraint_name
       and tc.table_schema = kcu.table_schema
       and tc.table_name = kcu.table_name
      join information_schema.constraint_column_usage ccu
        on tc.constraint_name = ccu.constraint_name
       and tc.table_schema = ccu.table_schema
      where tc.table_schema = 'public'
        and tc.constraint_type = 'FOREIGN KEY'
    )
    select
      c.table_schema,
      c.table_name,
      c.column_name,
      c.data_type,
      c.is_nullable,
      c.ordinal_position::int as ordinal_position,
      case when pk.column_name is null then false else true end as is_primary_key,
      fk.references_table,
      fk.references_column
    from information_schema.columns c
    left join primary_keys pk
      on pk.table_schema = c.table_schema
     and pk.table_name = c.table_name
     and pk.column_name = c.column_name
    left join foreign_keys fk
      on fk.table_schema = c.table_schema
     and fk.table_name = c.table_name
     and fk.column_name = c.column_name
    where c.table_schema = 'public'
      and c.table_name not like 'ask_%'
      and c.table_name not like 'ask_service_%'
    order by c.table_name asc, c.ordinal_position asc
    `
  );
  return rows as ColumnRow[];
}

function buildManifestRelationships(): RelationshipRow[] {
  const relationships: RelationshipRow[] = [];
  for (const [tableName, hint] of Object.entries(ASK_CATALOG_MANIFEST)) {
    for (const override of hint.joinOverrides || []) {
      relationships.push({
        from_table: tableName,
        from_column: override.fromColumn,
        to_table: override.toTable,
        to_column: override.toColumn,
        relationship_type: 'join_override',
        source: 'manifest',
        cardinality: override.cardinality || 'many_to_one'
      });
    }
  }
  return relationships;
}

function buildCatalogRecords(tenant: TenantCatalogTarget, columns: ColumnRow[]) {
  const columnsByTable = new Map<string, ColumnRow[]>();
  for (const column of columns) {
    const bucket = columnsByTable.get(column.table_name) || [];
    bucket.push(column);
    columnsByTable.set(column.table_name, bucket);
  }

  const tableRecords: CatalogRecord[] = [];
  const columnRecords: CatalogColumnRecord[] = [];
  const relationshipRecords: CatalogRelationshipRecord[] = [];
  const aliasRecords: CatalogAliasRecord[] = [];
  const relationshipKeySet = new Set<string>();
  const aliasKeySet = new Set<string>();

  for (const [tableName, tableColumns] of columnsByTable.entries()) {
    const hint = ASK_CATALOG_MANIFEST[tableName];
    const primaryKeyColumns = tableColumns.filter((column) => column.is_primary_key).map((column) => column.column_name);
    const dateColumns = inferDateColumns(tableColumns, hint);
    const tenantColumn = inferTenantColumn(tableColumns, hint);
    // For manifest tables, use explicit hints. For all others, derive from inferred column roles
    // so non-manifest tables are still discoverable by business term search.
    const metricHints = hint?.metricHints?.length
      ? hint.metricHints
      : tableColumns
          .filter((column) => inferSemanticRole(column.column_name, column.data_type) === 'metric')
          .map((column) => column.column_name.replace(/_/g, ' '));
    const dimensionHints = hint?.dimensionHints?.length
      ? hint.dimensionHints
      : tableColumns
          .filter((column) => inferSemanticRole(column.column_name, column.data_type) === 'dimension')
          .map((column) => column.column_name.replace(/_/g, ' '));
    const description = hint?.description || `${titleCase(tableName)} data available for analytics queries.`;
    const displayName = titleCase(tableName);
    const tableAliases = Array.from(new Set([...(hint?.aliases || []), ...defaultTableAliases(tableName), ...metricHints, ...dimensionHints]));
    const searchText = buildSearchText([
      tableName,
      displayName,
      description,
      tenantColumn,
      ...primaryKeyColumns,
      ...dateColumns,
      ...metricHints,
      ...dimensionHints,
      ...tableAliases,
      ...tableColumns.map((column) => column.column_name)
    ]);

    tableRecords.push({
      id: randomUUID(),
      tenantId: tenant.id,
      schemaName: tableColumns[0]?.table_schema || 'public',
      tableName,
      displayName,
      description,
      tenantColumn,
      primaryKeyColumns,
      dateColumns,
      metricHints,
      dimensionHints,
      searchText,
      metadata: {
        tenantCode: tenant.tenantCode,
        source: 'catalog_refresh'
      }
    });

    for (const alias of tableAliases) {
      const aliasKey = ['table', tableName, alias.toLowerCase()].join(':');
      if (aliasKeySet.has(aliasKey)) {
        continue;
      }
      aliasKeySet.add(aliasKey);
      aliasRecords.push({
        id: randomUUID(),
        tenantId: tenant.id,
        objectType: 'table',
        objectName: tableName,
        tableName,
        columnName: null,
        alias,
        weight: metricHints.includes(alias) ? 5 : dimensionHints.includes(alias) ? 4 : 3,
        source: 'manifest',
        searchText: buildSearchText([alias, tableName, description]),
        metadata: {
          tableName
        }
      });
    }

    for (const column of tableColumns) {
      const columnHint = hint?.columns?.[column.column_name];
      const semanticRole = inferSemanticRole(column.column_name, column.data_type, columnHint);
      const columnAliases = Array.from(
        new Set([...(columnHint?.aliases || []), column.column_name.replace(/_/g, ' '), titleCase(column.column_name)])
      );
      const columnDescription =
        columnHint?.description ||
        `${titleCase(column.column_name)} on ${displayName}${semanticRole ? ` (${semanticRole})` : ''}.`;
      const columnSearchText = buildSearchText([
        tableName,
        displayName,
        column.column_name,
        columnDescription,
        semanticRole,
        column.data_type,
        ...columnAliases
      ]);

      columnRecords.push({
        id: randomUUID(),
        tenantId: tenant.id,
        tableName,
        columnName: column.column_name,
        dataType: column.data_type,
        isNullable: column.is_nullable === 'YES',
        ordinalPosition: Number(column.ordinal_position),
        isPrimaryKey: Boolean(column.is_primary_key),
        isForeignKey: Boolean(column.references_table),
        referencesTable: column.references_table,
        referencesColumn: column.references_column,
        semanticRole,
        description: columnDescription,
        searchText: columnSearchText,
        metadata: {
          aliases: columnAliases
        }
      });

      for (const alias of columnAliases) {
        const aliasKey = ['column', tableName, column.column_name, alias.toLowerCase()].join(':');
        if (aliasKeySet.has(aliasKey)) {
          continue;
        }
        aliasKeySet.add(aliasKey);
        aliasRecords.push({
          id: randomUUID(),
          tenantId: tenant.id,
          objectType: 'column',
          objectName: `${tableName}.${column.column_name}`,
          tableName,
          columnName: column.column_name,
          alias,
          weight: semanticRole === 'metric' ? 4 : semanticRole === 'date' ? 3 : 2,
          source: columnHint?.aliases?.includes(alias) ? 'manifest' : 'derived',
          searchText: buildSearchText([alias, tableName, column.column_name, columnDescription]),
          metadata: {
            tableName,
            columnName: column.column_name,
            semanticRole
          }
        });
      }

      if (column.references_table && column.references_column) {
        const relationshipKey = [tableName, column.column_name, column.references_table, column.references_column, 'database'].join(':');
        if (!relationshipKeySet.has(relationshipKey)) {
          relationshipKeySet.add(relationshipKey);
          relationshipRecords.push({
            id: randomUUID(),
            tenantId: tenant.id,
            fromTable: tableName,
            fromColumn: column.column_name,
            toTable: column.references_table,
            toColumn: column.references_column,
            relationshipType: 'foreign_key',
            cardinality: 'many_to_one',
            source: 'database',
            searchText: buildSearchText([tableName, column.column_name, column.references_table, column.references_column, 'join relationship']),
            metadata: {}
          });
        }
      }
    }
  }

  for (const relationship of buildManifestRelationships()) {
    const relationshipKey = [
      relationship.from_table,
      relationship.from_column,
      relationship.to_table,
      relationship.to_column,
      relationship.source
    ].join(':');
    if (relationshipKeySet.has(relationshipKey)) {
      continue;
    }
    relationshipKeySet.add(relationshipKey);
    relationshipRecords.push({
      id: randomUUID(),
      tenantId: tenant.id,
      fromTable: relationship.from_table,
      fromColumn: relationship.from_column,
      toTable: relationship.to_table,
      toColumn: relationship.to_column,
      relationshipType: relationship.relationship_type,
      cardinality: relationship.cardinality,
      source: relationship.source,
      searchText: buildSearchText([
        relationship.from_table,
        relationship.from_column,
        relationship.to_table,
        relationship.to_column,
        'join override'
      ]),
      metadata: {}
    });
  }

  return {
    tableRecords,
    columnRecords,
    relationshipRecords,
    aliasRecords
  };
}

async function insertCatalogRecords(
  db: DataSource,
  tenantId: number,
  tables: CatalogRecord[],
  columns: CatalogColumnRecord[],
  relationships: CatalogRelationshipRecord[],
  aliases: CatalogAliasRecord[]
): Promise<void> {
  const runner = db.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    await runner.query('delete from ask_catalog_aliases where tenant_id = $1', [tenantId]);
    await runner.query('delete from ask_catalog_relationships where tenant_id = $1', [tenantId]);
    await runner.query('delete from ask_catalog_columns where tenant_id = $1', [tenantId]);
    await runner.query('delete from ask_catalog_tables where tenant_id = $1', [tenantId]);

    for (const table of tables) {
      await runner.query(
        `
        insert into ask_catalog_tables (
          id, tenant_id, schema_name, table_name, display_name, description,
          tenant_column, primary_key_columns, date_columns, metric_hints,
          dimension_hints, search_text, metadata
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13::jsonb)
        `,
        [
          table.id,
          table.tenantId,
          table.schemaName || 'public',
          table.tableName,
          table.displayName || null,
          table.description || null,
          table.tenantColumn || null,
          JSON.stringify(table.primaryKeyColumns || []),
          JSON.stringify(table.dateColumns || []),
          JSON.stringify(table.metricHints || []),
          JSON.stringify(table.dimensionHints || []),
          table.searchText,
          JSON.stringify(table.metadata || {})
        ]
      );
    }

    for (const column of columns) {
      await runner.query(
        `
        insert into ask_catalog_columns (
          id, tenant_id, table_name, column_name, data_type, is_nullable, ordinal_position,
          is_primary_key, is_foreign_key, references_table, references_column,
          semantic_role, description, search_text, metadata
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
        `,
        [
          column.id,
          column.tenantId,
          column.tableName,
          column.columnName,
          column.dataType,
          column.isNullable,
          column.ordinalPosition,
          column.isPrimaryKey,
          column.isForeignKey,
          column.referencesTable || null,
          column.referencesColumn || null,
          column.semanticRole || null,
          column.description || null,
          column.searchText,
          JSON.stringify(column.metadata || {})
        ]
      );
    }

    for (const relationship of relationships) {
      await runner.query(
        `
        insert into ask_catalog_relationships (
          id, tenant_id, from_table, from_column, to_table, to_column,
          relationship_type, cardinality, source, search_text, metadata
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
        `,
        [
          relationship.id,
          relationship.tenantId,
          relationship.fromTable,
          relationship.fromColumn,
          relationship.toTable,
          relationship.toColumn,
          relationship.relationshipType,
          relationship.cardinality,
          relationship.source,
          relationship.searchText,
          JSON.stringify(relationship.metadata || {})
        ]
      );
    }

    for (const alias of aliases) {
      await runner.query(
        `
        insert into ask_catalog_aliases (
          id, tenant_id, object_type, object_name, table_name, column_name,
          alias, weight, source, search_text, metadata
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
        `,
        [
          alias.id,
          alias.tenantId,
          alias.objectType,
          alias.objectName,
          alias.tableName || null,
          alias.columnName || null,
          alias.alias,
          alias.weight,
          alias.source,
          alias.searchText,
          JSON.stringify(alias.metadata || {})
        ]
      );
    }

    await runner.commitTransaction();
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

export async function insertSemanticRecords(
  db: DataSource,
  tenantId: number,
  records: SemanticRefreshRecords
): Promise<void> {
  const runner = db.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    await runner.query('delete from ask_threshold_policies where tenant_id = $1', [tenantId]);
    await runner.query('delete from ask_date_policies where tenant_id = $1', [tenantId]);
    await runner.query('delete from ask_join_policies where tenant_id = $1', [tenantId]);
    await runner.query('delete from ask_metric_aliases where tenant_id = $1', [tenantId]);
    await runner.query('delete from ask_metrics where tenant_id = $1', [tenantId]);
    await runner.query('delete from ask_entities where tenant_id = $1', [tenantId]);
    await runner.query('delete from ask_question_variants where tenant_id = $1', [tenantId]);
    await runner.query('delete from ask_canonical_questions where tenant_id = $1', [tenantId]);
    await runner.query('delete from ask_question_clusters where tenant_id = $1', [tenantId]);
    await runner.query('delete from ask_semantic_pack_versions where tenant_id = $1', [tenantId]);
    await runner.query('delete from ask_semantic_packs where tenant_id = $1', [tenantId]);

    await runner.query(
      `
      insert into ask_semantic_packs (id, tenant_id, source_path, metadata)
      values ($1, $2, $3, $4::jsonb)
      `,
      [
        records.semanticPack.id,
        records.semanticPack.tenantId,
        records.semanticPack.sourcePath,
        JSON.stringify(records.semanticPack.metadata || {})
      ]
    );

    await runner.query(
      `
      insert into ask_semantic_pack_versions (
        id, tenant_id, semantic_pack_id, refresh_id, source_path, status,
        cluster_count, canonical_question_count, variant_count, entity_count, metric_count, metadata
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
      `,
      [
        records.semanticPackVersion.id,
        records.semanticPackVersion.tenantId,
        records.semanticPackVersion.semanticPackId,
        records.semanticPackVersion.refreshId,
        records.semanticPackVersion.sourcePath,
        records.semanticPackVersion.status,
        records.semanticPackVersion.clusterCount,
        records.semanticPackVersion.canonicalQuestionCount,
        records.semanticPackVersion.variantCount,
        records.semanticPackVersion.entityCount,
        records.semanticPackVersion.metricCount,
        JSON.stringify(records.semanticPackVersion.metadata || {})
      ]
    );

    for (const cluster of records.clusters) {
      await runner.query(
        `
        insert into ask_question_clusters (
          id, tenant_id, cluster_key, cluster_number, title, description, question_count, search_text, metadata
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        `,
        [
          cluster.id,
          cluster.tenantId,
          cluster.clusterKey,
          cluster.clusterNumber,
          cluster.title,
          cluster.description,
          cluster.questionCount,
          cluster.searchText,
          JSON.stringify(cluster.metadata || {})
        ]
      );
    }

    for (const question of records.canonicalQuestions) {
      await runner.query(
        `
        insert into ask_canonical_questions (
          id, tenant_id, cluster_key, question_number, canonical_question, data_sources, complexity, primary_entity, search_text, metadata
        )
        values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb)
        `,
        [
          question.id,
          question.tenantId,
          question.clusterKey,
          question.questionNumber,
          question.canonicalQuestion,
          JSON.stringify(question.dataSources),
          question.complexity,
          question.primaryEntity,
          question.searchText,
          JSON.stringify(question.metadata || {})
        ]
      );
    }

    for (const variant of records.questionVariants) {
      await runner.query(
        `
        insert into ask_question_variants (
          id, tenant_id, canonical_question_id, canonical_question_number, variant_text, ordinal_position, search_text, metadata
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        `,
        [
          variant.id,
          variant.tenantId,
          variant.canonicalQuestionId,
          variant.canonicalQuestionNumber,
          variant.variantText,
          variant.ordinalPosition,
          variant.searchText,
          JSON.stringify(variant.metadata || {})
        ]
      );
    }

    for (const entity of records.entities) {
      await runner.query(
        `
        insert into ask_entities (id, tenant_id, entity_key, display_name, aliases, search_text, metadata)
        values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
        `,
        [
          entity.id,
          entity.tenantId,
          entity.entityKey,
          entity.displayName,
          JSON.stringify(entity.aliases),
          entity.searchText,
          JSON.stringify(entity.metadata || {})
        ]
      );
    }

    for (const metric of records.metrics) {
      await runner.query(
        `
        insert into ask_metrics (id, tenant_id, metric_key, display_name, aliases, search_text, metadata)
        values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
        `,
        [
          metric.id,
          metric.tenantId,
          metric.metricKey,
          metric.displayName,
          JSON.stringify(metric.aliases),
          metric.searchText,
          JSON.stringify(metric.metadata || {})
        ]
      );
    }

    for (const alias of records.metricAliases) {
      await runner.query(
        `
        insert into ask_metric_aliases (id, tenant_id, metric_key, alias, weight, search_text, metadata)
        values ($1, $2, $3, $4, $5, $6, $7::jsonb)
        `,
        [alias.id, alias.tenantId, alias.metricKey, alias.alias, alias.weight, alias.searchText, JSON.stringify(alias.metadata || {})]
      );
    }

    for (const policy of records.joinPolicies) {
      await runner.query(
        `
        insert into ask_join_policies (id, tenant_id, policy_key, from_table, to_table, via_tables, join_edges, preferred, search_text, metadata)
        values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb)
        `,
        [
          policy.id,
          policy.tenantId,
          policy.policyKey,
          policy.fromTable,
          policy.toTable,
          JSON.stringify(policy.viaTables),
          JSON.stringify(policy.joinEdges),
          policy.preferred,
          policy.searchText,
          JSON.stringify(policy.metadata || {})
        ]
      );
    }

    for (const policy of records.datePolicies) {
      await runner.query(
        `
        insert into ask_date_policies (id, tenant_id, policy_key, metric_key, date_column, time_grains, timezone, semantics, search_text, metadata)
        values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb)
        `,
        [
          policy.id,
          policy.tenantId,
          policy.policyKey,
          policy.metricKey,
          policy.dateColumn,
          JSON.stringify(policy.timeGrains),
          policy.timezone,
          policy.semantics,
          policy.searchText,
          JSON.stringify(policy.metadata || {})
        ]
      );
    }

    for (const policy of records.thresholdPolicies) {
      await runner.query(
        `
        insert into ask_threshold_policies (id, tenant_id, policy_key, metric_key, threshold_name, comparator, threshold_value, search_text, metadata)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        `,
        [
          policy.id,
          policy.tenantId,
          policy.policyKey,
          policy.metricKey,
          policy.thresholdName,
          policy.comparator,
          policy.thresholdValue,
          policy.searchText,
          JSON.stringify(policy.metadata || {})
        ]
      );
    }

    await runner.commitTransaction();
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

export async function refreshCatalogForTenant(
  db: DataSource,
  tenant: TenantCatalogTarget,
  _triggeredBy: string
): Promise<CatalogRefreshResult> {
  await ensureAskCatalogSchema(db);
  const refreshId = randomUUID();
  await db.query(
    `
    insert into ask_catalog_refreshes (
      id, tenant_id, status, strategy, started_at, created_at, updated_at
    )
    values ($1, $2, 'running', 'catalog_refresh', now(), now(), now())
    `,
    [refreshId, tenant.id]
  );

  try {
    const columns = await loadColumns(db);
    const { tableRecords, columnRecords, relationshipRecords, aliasRecords } = buildCatalogRecords(tenant, columns);
    await insertCatalogRecords(db, tenant.id, tableRecords, columnRecords, relationshipRecords, aliasRecords);
    const semanticRecords = buildSemanticRefreshRecords(tenant, refreshId, undefined, relationshipRecords);
    await insertSemanticRecords(db, tenant.id, semanticRecords);
    await db.query(
      `
      update ask_catalog_refreshes
      set
        status = 'completed',
        refreshed_tables = $2,
        refreshed_columns = $3,
        refreshed_relationships = $4,
        refreshed_aliases = $5,
        completed_at = now(),
        updated_at = now(),
        error_message = null
      where id = $1
      `,
      [refreshId, tableRecords.length, columnRecords.length, relationshipRecords.length, aliasRecords.length]
    );

    const semanticPackRows = await db.query(
      `
      select id
      from ask_semantic_pack_versions
      where tenant_id = $1 and refresh_id = $2
      order by created_at desc
      limit 1
      `,
      [tenant.id, refreshId]
    );
    const semanticPackVersionId = String(semanticPackRows[0]?.id || '');
    if (!semanticPackVersionId) {
      throw new Error('semantic pack version missing after catalog refresh');
    }

    const snapshot = buildGraphSnapshot(tenant.id, refreshId, tableRecords, relationshipRecords, aliasRecords, columnRecords);
    const graphWarmed = await warmGraphCache(tenant.id, refreshId, snapshot);
    if (!graphWarmed) {
      throw new Error('Ask graph cache warm failed');
    }

    const readinessRows = await db.query(
      `
      select status, refreshed_tables
      from ask_catalog_refreshes
      where id = $1 and tenant_id = $2
      limit 1
      `,
      [refreshId, tenant.id]
    );
    const catalogStatus = String(readinessRows[0]?.status || '');
    const refreshedTables = Number(readinessRows[0]?.refreshed_tables || 0);
    if (catalogStatus !== 'completed' || refreshedTables <= 0) {
      throw new Error('Ask catalog refresh readiness verification failed');
    }

    return {
      refreshId,
      refreshedTables: tableRecords.length,
      refreshedColumns: columnRecords.length,
      refreshedRelationships: relationshipRecords.length,
      refreshedAliases: aliasRecords.length,
      semanticPackVersionId,
      graphWarmed,
      askReady: true
    };
  } catch (error: any) {
    await db.query(
      `
      update ask_catalog_refreshes
      set
        status = 'failed',
        error_message = $2,
        completed_at = now(),
        updated_at = now()
      where id = $1
      `,
      [refreshId, error?.message || 'catalog refresh failed']
    );
    throw error;
  }
}
