import net from 'node:net';
import tls from 'node:tls';
import readline from 'node:readline';
import { once } from 'node:events';
import { URL } from 'node:url';
import { env } from '../config/env';

type GraphTableRecord = {
  tableName: string;
  displayName?: string;
  description?: string;
  tenantColumn?: string | null;
  primaryKeyColumns?: string[];
  dateColumns?: string[];
  metricHints?: string[];
  dimensionHints?: string[];
};

type GraphColumnRecord = {
  tableName: string;
  columnName: string;
  dataType: string;
  semanticRole?: string | null;
  isPrimaryKey?: boolean;
  referencesTable?: string | null;
  referencesColumn?: string | null;
};

type GraphRelationshipRecord = {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  relationshipType: string;
  cardinality: string;
  source: string;
};

type GraphAliasRecord = {
  objectType: string;
  objectName: string;
  tableName?: string | null;
  columnName?: string | null;
  alias: string;
  weight: number;
  source: string;
};

type RedisConfig = {
  host: string;
  port: number;
  db: number;
  username?: string;
  password?: string;
  useTls: boolean;
};

function getRedisConfig(): RedisConfig | null {
  if (env.ASK_REDIS_URL) {
    const parsed = new URL(env.ASK_REDIS_URL);
    if (!parsed.hostname) {
      return null;
    }
    return {
      host: parsed.hostname,
      port: Number(parsed.port || (parsed.protocol === 'rediss:' ? 6380 : 6379)),
      db: Number(parsed.pathname.replace('/', '') || 0),
      username: parsed.username || undefined,
      password: parsed.password || undefined,
      useTls: parsed.protocol === 'rediss:'
    };
  }

  const host = env.ASK_REDIS_HOST || env.REDIS_HOST;
  if (!host) {
    return null;
  }

  return {
    host,
    port: Number(env.ASK_REDIS_PORT || env.REDIS_PORT || 6379),
    db: Number(env.ASK_REDIS_DB || 0),
    username: env.ASK_REDIS_USERNAME || undefined,
    password: env.ASK_REDIS_PASSWORD || env.REDIS_PASSWORD || undefined,
    useTls: false
  };
}

function encodeCommand(parts: Array<string | number>): Buffer {
  const buffers: Buffer[] = [Buffer.from(`*${parts.length}\r\n`, 'utf8')];
  for (const part of parts) {
    const payload = Buffer.from(String(part), 'utf8');
    buffers.push(Buffer.from(`$${payload.length}\r\n`, 'utf8'));
    buffers.push(payload);
    buffers.push(Buffer.from('\r\n', 'utf8'));
  }
  return Buffer.concat(buffers);
}

async function sendSimpleCommand(
  writer: net.Socket | tls.TLSSocket,
  rl: readline.Interface,
  ...parts: Array<string | number>
): Promise<string> {
  writer.write(encodeCommand(parts));
  const [line] = (await Promise.race([
    once(rl, 'line'),
    once(writer, 'error').then(([error]) => Promise.reject(error)),
    once(writer, 'timeout').then(() => Promise.reject(new Error('Redis socket timeout')))
  ])) as [string];
  if (line.startsWith('-')) {
    throw new Error(line.slice(1));
  }
  if (line.startsWith('+') || line.startsWith(':')) {
    return line.slice(1);
  }
  return line;
}

function buildAdjacency(relationships: GraphRelationshipRecord[]): Record<string, Array<Record<string, string>>> {
  const adjacency: Record<string, Array<Record<string, string>>> = {};
  for (const relationship of relationships) {
    adjacency[relationship.fromTable] ||= [];
    adjacency[relationship.toTable] ||= [];
    adjacency[relationship.fromTable].push({
      fromTable: relationship.fromTable,
      fromColumn: relationship.fromColumn,
      toTable: relationship.toTable,
      toColumn: relationship.toColumn,
      relationshipType: relationship.relationshipType,
      cardinality: relationship.cardinality,
      source: relationship.source
    });
    adjacency[relationship.toTable].push({
      fromTable: relationship.toTable,
      fromColumn: relationship.toColumn,
      toTable: relationship.fromTable,
      toColumn: relationship.fromColumn,
      relationshipType: relationship.relationshipType,
      cardinality: relationship.cardinality,
      source: relationship.source
    });
  }
  return adjacency;
}

function buildAliasIndex(aliases: GraphAliasRecord[]): Record<string, Array<Record<string, string | number | null>>> {
  const aliasIndex: Record<string, Array<Record<string, string | number | null>>> = {};
  for (const alias of aliases) {
    const normalized = alias.alias.trim().toLowerCase();
    const tableName = alias.tableName || null;
    if (!normalized || !tableName) {
      continue;
    }
    aliasIndex[normalized] ||= [];
    aliasIndex[normalized].push({
      objectType: alias.objectType,
      objectName: alias.objectName,
      tableName,
      columnName: alias.columnName || null,
      weight: alias.weight,
      source: alias.source
    });
  }
  return aliasIndex;
}

export function buildGraphCacheKey(tenantId: number, refreshId: string): string {
  return `ask:graph:v1:tenant:${tenantId}:refresh:${refreshId}`;
}

function buildColumnsIndex(columns: GraphColumnRecord[]): Record<string, Array<Record<string, unknown>>> {
  const index: Record<string, Array<Record<string, unknown>>> = {};
  for (const col of columns) {
    index[col.tableName] ||= [];
    index[col.tableName].push({
      columnName: col.columnName,
      dataType: col.dataType,
      semanticRole: col.semanticRole || null,
      isPrimaryKey: col.isPrimaryKey || false,
      referencesTable: col.referencesTable || null,
      referencesColumn: col.referencesColumn || null
    });
  }
  return index;
}

export function buildGraphSnapshot(
  tenantId: number,
  refreshId: string,
  tables: GraphTableRecord[],
  relationships: GraphRelationshipRecord[],
  aliases: GraphAliasRecord[],
  columns: GraphColumnRecord[] = []
): Record<string, unknown> {
  const columnsIndex = buildColumnsIndex(columns);
  return {
    refreshId,
    tenantId: String(tenantId),
    tables: Object.fromEntries(
      tables.map((table) => [
        table.tableName,
        {
          tableName: table.tableName,
          displayName: table.displayName || null,
          description: table.description || null,
          tenantColumn: table.tenantColumn || null,
          primaryKeyColumns: table.primaryKeyColumns || [],
          dateColumns: table.dateColumns || [],
          metricHints: table.metricHints || [],
          dimensionHints: table.dimensionHints || [],
          columns: columnsIndex[table.tableName] || []
        }
      ])
    ),
    adjacency: buildAdjacency(relationships),
    aliasIndex: buildAliasIndex(aliases),
    joinPathMemo: {}
  };
}

export async function warmGraphCache(
  tenantId: number,
  refreshId: string,
  snapshot: Record<string, unknown>
): Promise<boolean> {
  const config = getRedisConfig();
  if (!config) {
    return false;
  }

  const socket = config.useTls
    ? tls.connect({ host: config.host, port: config.port })
    : net.createConnection({ host: config.host, port: config.port });
  socket.setTimeout(5000);
  await Promise.race([
    once(socket, 'connect'),
    once(socket, 'error').then(([error]) => Promise.reject(error)),
    once(socket, 'timeout').then(() => Promise.reject(new Error('Redis connect timeout')))
  ]);
  const rl = readline.createInterface({ input: socket });

  try {
    if (config.password) {
      if (config.username) {
        await sendSimpleCommand(socket, rl, 'AUTH', config.username, config.password);
      } else {
        await sendSimpleCommand(socket, rl, 'AUTH', config.password);
      }
    }
    if (config.db) {
      await sendSimpleCommand(socket, rl, 'SELECT', config.db);
    }
    await sendSimpleCommand(
      socket,
      rl,
      'SET',
      buildGraphCacheKey(tenantId, refreshId),
      JSON.stringify(snapshot),
      'EX',
      env.ASK_GRAPH_CACHE_TTL_SECONDS
    );
    return true;
  } finally {
    rl.close();
    socket.end();
  }
}
