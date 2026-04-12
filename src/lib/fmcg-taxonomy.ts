import { randomUUID } from 'crypto';
import compiledTaxonomyJson from './data/fmcg-taxonomy.compiled.json';

type TenantCatalogTarget = {
  id: number;
  tenantCode: string;
};

export type SemanticClusterRecord = {
  id: string;
  tenantId: number;
  clusterKey: string;
  clusterNumber: number;
  title: string;
  description: string;
  questionCount: number;
  searchText: string;
  metadata?: Record<string, unknown>;
};

export type CanonicalQuestionRecord = {
  id: string;
  tenantId: number;
  clusterKey: string;
  questionNumber: number;
  canonicalQuestion: string;
  dataSources: string[];
  complexity: string;
  primaryEntity: string;
  searchText: string;
  metadata?: Record<string, unknown>;
};

export type QuestionVariantRecord = {
  id: string;
  tenantId: number;
  canonicalQuestionId: string;
  canonicalQuestionNumber: number;
  variantText: string;
  ordinalPosition: number;
  searchText: string;
  metadata?: Record<string, unknown>;
};

export type SemanticEntityRecord = {
  id: string;
  tenantId: number;
  entityKey: string;
  displayName: string;
  aliases: string[];
  searchText: string;
  metadata?: Record<string, unknown>;
};

export type SemanticMetricRecord = {
  id: string;
  tenantId: number;
  metricKey: string;
  displayName: string;
  aliases: string[];
  searchText: string;
  metadata?: Record<string, unknown>;
};

export type MetricAliasRecord = {
  id: string;
  tenantId: number;
  metricKey: string;
  alias: string;
  weight: number;
  searchText: string;
  metadata?: Record<string, unknown>;
};

export type SemanticJoinPolicyRecord = {
  id: string;
  tenantId: number;
  policyKey: string;
  fromTable: string;
  toTable: string;
  viaTables: string[];
  joinEdges: Array<Record<string, unknown>>;
  preferred: boolean;
  searchText: string;
  metadata?: Record<string, unknown>;
};

export type SemanticDatePolicyRecord = {
  id: string;
  tenantId: number;
  policyKey: string;
  metricKey: string | null;
  dateColumn: string;
  timeGrains: string[];
  timezone: string;
  semantics: string;
  searchText: string;
  metadata?: Record<string, unknown>;
};

export type SemanticThresholdPolicyRecord = {
  id: string;
  tenantId: number;
  policyKey: string;
  metricKey: string | null;
  thresholdName: string;
  comparator: string;
  thresholdValue: string | null;
  searchText: string;
  metadata?: Record<string, unknown>;
};

export type SemanticPackRecord = {
  id: string;
  tenantId: number;
  sourcePath: string;
  metadata?: Record<string, unknown>;
};

export type SemanticPackVersionRecord = {
  id: string;
  tenantId: number;
  semanticPackId: string;
  refreshId: string;
  sourcePath: string;
  status: string;
  clusterCount: number;
  canonicalQuestionCount: number;
  variantCount: number;
  entityCount: number;
  metricCount: number;
  metadata?: Record<string, unknown>;
};

export type SemanticRefreshRecords = {
  semanticPack: SemanticPackRecord;
  semanticPackVersion: SemanticPackVersionRecord;
  clusters: SemanticClusterRecord[];
  canonicalQuestions: CanonicalQuestionRecord[];
  questionVariants: QuestionVariantRecord[];
  entities: SemanticEntityRecord[];
  metrics: SemanticMetricRecord[];
  metricAliases: MetricAliasRecord[];
  joinPolicies: SemanticJoinPolicyRecord[];
  datePolicies: SemanticDatePolicyRecord[];
  thresholdPolicies: SemanticThresholdPolicyRecord[];
};

type CompiledCluster = {
  clusterNumber: number;
  title: string;
  questionCount: number;
  questions: Array<{
    questionNumber: number;
    question: string;
    source: string;
    level: string;
    entity: string;
  }>;
};

type CompiledVariantBlock = {
  questionNumber: number;
  canonicalQuestion: string;
  variants: string[];
};

type CompiledTaxonomy = {
  version: string;
  source: string;
  clusterCount: number;
  questionCount: number;
  variantBlockCount: number;
  variantCount: number;
  clusters: CompiledCluster[];
  variantLibrary: CompiledVariantBlock[];
};

const COMPILED_TAXONOMY_SOURCE = 'repo:supe-analytics/src/lib/data/fmcg-taxonomy.compiled.json';
const COMPILED_TAXONOMY = compiledTaxonomyJson as CompiledTaxonomy;

const ENTITY_ALIASES: Record<string, string[]> = {
  salesman: ['salesman', 'salesmen', 'rep', 'mr', 'sr'],
  retailer: ['retailer', 'shop', 'store', 'outlet'],
  beat: ['beat', 'route', 'territory'],
  distributor: ['distributor', 'stockist'],
  geography: ['geography', 'region', 'zone', 'area', 'state'],
  sku: ['sku', 'product', 'item'],
  brand: ['brand'],
  channel: ['channel', 'gt', 'mt', 'general trade', 'modern trade'],
  all: ['all', 'overall', 'system'],
  manager: ['manager', 'asm', 'rsm', 'nsm'],
};

const METRIC_REGISTRY: Array<{ metricKey: string; displayName: string; aliases: string[] }> = [
  { metricKey: 'revenue', displayName: 'Revenue', aliases: ['revenue', 'billing', 'sales', 'topline'] },
  { metricKey: 'target', displayName: 'Target', aliases: ['target', 'goal', 'plan'] },
  { metricKey: 'attainment', displayName: 'Attainment', aliases: ['attainment', 'achievement'] },
  { metricKey: 'run_rate', displayName: 'Run Rate', aliases: ['run rate', 'pace', 'projection', 'forecast'] },
  { metricKey: 'aov', displayName: 'Average Order Value', aliases: ['aov', 'average order value', 'per-bill value', 'invoice amount'] },
  { metricKey: 'outstanding', displayName: 'Outstanding', aliases: ['outstanding', 'pending', 'dues'] },
  { metricKey: 'collection', displayName: 'Collection', aliases: ['collection', 'recovery', 'payment'] },
  { metricKey: 'coverage', displayName: 'Coverage', aliases: ['coverage', 'outlet coverage', 'visited'] },
  { metricKey: 'productive_calls', displayName: 'Productive Calls', aliases: ['productive call', 'strike rate', 'converted visits'] },
  { metricKey: 'adherence', displayName: 'Adherence', aliases: ['adherence', 'beat adherence'] },
  { metricKey: 'frequency', displayName: 'Order Frequency', aliases: ['frequency', 'visit frequency', 'order frequency'] },
  { metricKey: 'dormancy', displayName: 'Dormancy', aliases: ['dormant', 'dormancy', 'inactive'] },
  { metricKey: 'growth', displayName: 'Growth', aliases: ['growth', 'uplift', 'cagr'] },
  { metricKey: 'units', displayName: 'Units', aliases: ['units', 'volume'] },
  { metricKey: 'mix', displayName: 'Mix', aliases: ['mix', 'basket'] },
  { metricKey: 'penetration', displayName: 'Penetration', aliases: ['penetration', 'distribution'] },
  { metricKey: 'damage', displayName: 'Damage', aliases: ['damage', 'returns'] },
  { metricKey: 'fill_rate', displayName: 'Fill Rate', aliases: ['fill rate', 'fulfilment', 'service level'] },
  { metricKey: 'inventory_days', displayName: 'Inventory Days', aliases: ['inventory', 'stock', 'inventory days', 'stockout'] },
  { metricKey: 'whitespace', displayName: 'Whitespace', aliases: ['whitespace', 'headroom', 'expansion'] },
  { metricKey: 'launch_velocity', displayName: 'Launch Velocity', aliases: ['launch', 'trial', 'ramp'] },
  { metricKey: 'roi', displayName: 'ROI', aliases: ['roi', 'scheme roi'] },
  { metricKey: 'seasonality', displayName: 'Seasonality', aliases: ['seasonal', 'festival', 'weekday'] },
  { metricKey: 'productivity', displayName: 'Productivity', aliases: ['productivity', 'efficiency', 'yield'] },
  { metricKey: 'scenario_impact', displayName: 'Scenario Impact', aliases: ['what if', 'scenario', 'impact', 'intervention'] },
];

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

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

function buildEntityRecords(tenant: TenantCatalogTarget, canonicalQuestions: CanonicalQuestionRecord[]): SemanticEntityRecord[] {
  const entities = new Map<string, SemanticEntityRecord>();
  for (const question of canonicalQuestions) {
    const entityKey = normalizeKey(question.primaryEntity || 'all');
    if (!entityKey) {
      continue;
    }
    if (entities.has(entityKey)) {
      continue;
    }
    const aliases = Array.from(new Set(ENTITY_ALIASES[entityKey] || [entityKey, titleCase(entityKey)]));
    entities.set(entityKey, {
      id: randomUUID(),
      tenantId: tenant.id,
      entityKey,
      displayName: titleCase(entityKey),
      aliases,
      searchText: buildSearchText([entityKey, titleCase(entityKey), ...aliases]),
      metadata: {
        source: 'taxonomy_markdown',
      }
    });
  }
  return Array.from(entities.values()).sort((left, right) => left.entityKey.localeCompare(right.entityKey));
}

function buildMetricRecords(tenant: TenantCatalogTarget, canonicalQuestions: CanonicalQuestionRecord[]): {
  metrics: SemanticMetricRecord[];
  metricAliases: MetricAliasRecord[];
} {
  const questionText = canonicalQuestions.map((question) => question.canonicalQuestion.toLowerCase()).join('\n');
  const metrics: SemanticMetricRecord[] = [];
  const aliases: MetricAliasRecord[] = [];
  for (const metric of METRIC_REGISTRY) {
    const matchesQuestion = metric.aliases.some((alias) => questionText.includes(alias.toLowerCase()));
    if (!matchesQuestion) {
      continue;
    }
    metrics.push({
      id: randomUUID(),
      tenantId: tenant.id,
      metricKey: metric.metricKey,
      displayName: metric.displayName,
      aliases: metric.aliases,
      searchText: buildSearchText([metric.metricKey, metric.displayName, ...metric.aliases]),
      metadata: {
        source: 'bootstrap_registry',
      }
    });
    for (const alias of metric.aliases) {
      aliases.push({
        id: randomUUID(),
        tenantId: tenant.id,
        metricKey: metric.metricKey,
        alias,
        weight: alias === metric.metricKey ? 5 : 3,
        searchText: buildSearchText([metric.metricKey, metric.displayName, alias]),
        metadata: {
          source: 'bootstrap_registry',
        }
      });
    }
  }
  return { metrics, metricAliases: aliases };
}

function buildDatePolicies(
  tenant: TenantCatalogTarget,
  refreshId: string,
  canonicalQuestions: CanonicalQuestionRecord[]
): SemanticDatePolicyRecord[] {
  const grains = new Set<string>();
  for (const question of canonicalQuestions) {
    const normalized = question.canonicalQuestion.toLowerCase();
    if (normalized.includes('mtd') || normalized.includes('month')) {
      grains.add('mtd');
      grains.add('monthly');
    }
    if (normalized.includes('week')) {
      grains.add('weekly');
    }
    if (normalized.includes('day') || normalized.includes('today')) {
      grains.add('daily');
    }
  }
  return [
    {
      id: randomUUID(),
      tenantId: tenant.id,
      policyKey: `wall_clock_primary_${refreshId}`,
      metricKey: null,
      dateColumn: 'order_sale_date',
      timeGrains: Array.from(grains.size ? grains : new Set(['mtd', 'monthly'])).sort(),
      timezone: 'Asia/Kolkata',
      semantics: 'wall_clock',
      searchText: buildSearchText(['order_sale_date', 'wall clock', 'mtd', 'monthly', 'weekly', 'daily']),
      metadata: {
        source: 'semantic_refresh',
      }
    }
  ];
}

function buildJoinPolicies(
  tenant: TenantCatalogTarget,
  relationshipRows: Array<{
    fromTable: string;
    fromColumn: string;
    toTable: string;
    toColumn: string;
    relationshipType: string;
    cardinality: string;
    source: string;
  }>
): SemanticJoinPolicyRecord[] {
  const grouped = new Map<
    string,
    {
      fromTable: string;
      toTable: string;
      edges: Array<{
        fromTable: string;
        fromColumn: string;
        toTable: string;
        toColumn: string;
        relationshipType: string;
        cardinality: string;
        source: string;
      }>;
    }
  >();

  for (const relationship of relationshipRows) {
    const policyKey = `${relationship.fromTable}__${relationship.toTable}`;
    const existing = grouped.get(policyKey);
    const edge = {
      fromTable: relationship.fromTable,
      fromColumn: relationship.fromColumn,
      toTable: relationship.toTable,
      toColumn: relationship.toColumn,
      relationshipType: relationship.relationshipType,
      cardinality: relationship.cardinality,
      source: relationship.source,
    };
    if (existing) {
      existing.edges.push(edge);
      continue;
    }
    grouped.set(policyKey, {
      fromTable: relationship.fromTable,
      toTable: relationship.toTable,
      edges: [edge]
    });
  }

  return Array.from(grouped.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([policyKey, group]) => {
      const joinEdges = [...group.edges].sort((left, right) => {
        const fromComparison = left.fromColumn.localeCompare(right.fromColumn);
        if (fromComparison !== 0) return fromComparison;
        const toComparison = left.toColumn.localeCompare(right.toColumn);
        if (toComparison !== 0) return toComparison;
        return left.source.localeCompare(right.source);
      });
      return {
        id: randomUUID(),
        tenantId: tenant.id,
        policyKey,
        fromTable: group.fromTable,
        toTable: group.toTable,
        viaTables: [],
        joinEdges,
        preferred: joinEdges.some((edge) => edge.source === 'database'),
        searchText: buildSearchText([
          group.fromTable,
          group.toTable,
          ...joinEdges.flatMap((edge) => [edge.fromColumn, edge.toColumn])
        ]),
        metadata: {
          source: 'catalog_relationship',
        }
      };
    });
}

export function buildSemanticRefreshRecords(
  tenant: TenantCatalogTarget,
  refreshId: string,
  sourcePath: string | undefined,
  relationshipRows: Array<{
    fromTable: string;
    fromColumn: string;
    toTable: string;
    toColumn: string;
    relationshipType: string;
    cardinality: string;
    source: string;
  }>
): SemanticRefreshRecords {
  const resolvedSourcePath = sourcePath || COMPILED_TAXONOMY_SOURCE;
  const parsedClusters = COMPILED_TAXONOMY.clusters;
  const parsedVariants = new Map<number, CompiledVariantBlock>(
    COMPILED_TAXONOMY.variantLibrary.map((variantBlock) => [variantBlock.questionNumber, variantBlock])
  );

  const semanticPack: SemanticPackRecord = {
    id: randomUUID(),
    tenantId: tenant.id,
    sourcePath: resolvedSourcePath,
    metadata: {
      tenantCode: tenant.tenantCode,
      source: 'taxonomy_markdown',
    }
  };

  const clusters: SemanticClusterRecord[] = [];
  const canonicalQuestions: CanonicalQuestionRecord[] = [];
  const questionVariants: QuestionVariantRecord[] = [];

  for (const parsedCluster of parsedClusters) {
    const clusterKey = normalizeKey(parsedCluster.title);
    clusters.push({
      id: randomUUID(),
      tenantId: tenant.id,
      clusterKey,
      clusterNumber: parsedCluster.clusterNumber,
      title: parsedCluster.title,
      description: `${parsedCluster.title} questions for FMCG leadership analysis.`,
      questionCount: parsedCluster.questionCount,
      searchText: buildSearchText([parsedCluster.title, ...parsedCluster.questions.map((question) => question.question)]),
      metadata: {
        source: 'taxonomy_markdown',
      }
    });
    for (const parsedQuestion of parsedCluster.questions) {
      const canonicalQuestionId = randomUUID();
      canonicalQuestions.push({
        id: canonicalQuestionId,
        tenantId: tenant.id,
        clusterKey,
        questionNumber: parsedQuestion.questionNumber,
        canonicalQuestion: parsedQuestion.question,
        dataSources: parsedQuestion.source.split('+').map((source) => source.trim()),
        complexity: parsedQuestion.level,
        primaryEntity: parsedQuestion.entity,
        searchText: buildSearchText([
          parsedCluster.title,
          parsedQuestion.question,
          parsedQuestion.source,
          parsedQuestion.level,
          parsedQuestion.entity,
        ]),
        metadata: {
          clusterNumber: parsedCluster.clusterNumber,
          source: 'taxonomy_markdown',
        }
      });
      const variantBlock = parsedVariants.get(parsedQuestion.questionNumber);
      for (const [index, variantText] of (variantBlock?.variants || []).entries()) {
        questionVariants.push({
          id: randomUUID(),
          tenantId: tenant.id,
          canonicalQuestionId,
          canonicalQuestionNumber: parsedQuestion.questionNumber,
          variantText,
          ordinalPosition: index + 1,
          searchText: buildSearchText([parsedQuestion.question, variantText, parsedCluster.title]),
          metadata: {
            isHinglish: /hinglish|kitna|kya|kaun|kaise|hai|mein|waale/i.test(variantText),
            source: 'taxonomy_markdown',
          }
        });
      }
    }
  }

  const { metrics, metricAliases } = buildMetricRecords(tenant, canonicalQuestions);
  const entities = buildEntityRecords(tenant, canonicalQuestions);
  const joinPolicies = buildJoinPolicies(tenant, relationshipRows);
  const datePolicies = buildDatePolicies(tenant, refreshId, canonicalQuestions);
  const thresholdPolicies: SemanticThresholdPolicyRecord[] = [];

  const semanticPackVersion: SemanticPackVersionRecord = {
    id: randomUUID(),
    tenantId: tenant.id,
    semanticPackId: semanticPack.id,
    refreshId,
    sourcePath: resolvedSourcePath,
    status: 'completed',
    clusterCount: clusters.length,
    canonicalQuestionCount: canonicalQuestions.length,
    variantCount: questionVariants.length,
    entityCount: entities.length,
    metricCount: metrics.length,
    metadata: {
      source: 'taxonomy_markdown',
    }
  };

  return {
    semanticPack,
    semanticPackVersion,
    clusters,
    canonicalQuestions,
    questionVariants,
    entities,
    metrics,
    metricAliases,
    joinPolicies,
    datePolicies,
    thresholdPolicies,
  };
}
