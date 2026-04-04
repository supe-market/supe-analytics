import { randomUUID } from 'crypto';
import type { DataSource } from 'typeorm';
import { ASK_CATALOG_MANIFEST, type CatalogColumnHint, type CatalogTableHint } from './ask-catalog-manifest';
import { buildGraphSnapshot, warmGraphCache } from './ask-graph-cache';

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
  refreshedTables: number;
  refreshedColumns: number;
  refreshedRelationships: number;
  refreshedAliases: number;
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
`;

async function ensureAskCatalogSchema(db: DataSource): Promise<void> {
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
    const metricHints = hint?.metricHints || [];
    const dimensionHints = hint?.dimensionHints || [];
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
    try {
      const snapshot = buildGraphSnapshot(tenant.id, refreshId, tableRecords, relationshipRecords, aliasRecords);
      await warmGraphCache(tenant.id, refreshId, snapshot);
    } catch (_error) {
      // Graph cache warmup is best-effort; supe-ask can rebuild from Postgres if Redis is unavailable.
    }
    return {
      refreshedTables: tableRecords.length,
      refreshedColumns: columnRecords.length,
      refreshedRelationships: relationshipRecords.length,
      refreshedAliases: aliasRecords.length
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
