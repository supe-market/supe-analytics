import { z } from 'zod';

export const observeEntityTypeSchema = z.enum([
  'salesman',
  'retailer',
  'beat',
  'sku',
  'distributor',
  'geography',
  'person'
]);

export const observeListQuerySchema = z.object({
  timeRange: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(500).optional().default(50),
  zone: z.string().optional(),
  region: z.string().optional(),
  area: z.string().optional()
});

export const observeDetailQuerySchema = z.object({
  timeRange: z.string().optional()
});

export const compareRunSchema = z.object({
  compareDimension: z.enum(['geography', 'distributor', 'sku']).optional(),
  entityType: z.enum(['geography', 'distributor', 'sku']).optional(),
  selectedMetrics: z.array(z.string()).optional(),
  metrics: z.array(z.string()).optional(),
  selectedEntities: z.array(z.string()).optional(),
  entityIds: z.array(z.string()).optional(),
  filters: z.record(z.string(), z.any()).optional(),
  timeRange: z.string().optional(),
  periodLabel: z.string().optional(),
  snapshotDate: z.string().optional()
});

export const signalDefaultsSchema = z.object({
  defaults: z.array(
    z.object({
      signalDefinitionId: z.coerce.number().optional(),
      entityType: z.string().optional(),
      signalKey: z.string().optional(),
      thresholdValue: z.coerce.number(),
      isEnabled: z.boolean().optional().default(true)
    })
  )
});

export const signalOverridesSchema = z.object({
  replaceSignalDefinitionIds: z.array(z.coerce.number()).optional().default([]),
  overrides: z.array(
    z.object({
      signalDefinitionId: z.coerce.number().optional(),
      entityType: z.string().optional(),
      signalKey: z.string().optional(),
      zone: z.string().min(1),
      thresholdValue: z.coerce.number(),
      isEnabled: z.boolean().optional().default(true)
    })
  )
});

const actionTargetSchema = z.object({
  entityType: z.enum(['salesman', 'retailer', 'beat', 'sku', 'distributor']),
  entityId: z.string().min(1),
  entityName: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional()
});

const taskPayloadSchema = z.object({
  assignee: z.string().min(1),
  instruction: z.string().min(1),
  deadline: z.string().optional().nullable(),
  entityType: z.enum(['salesman', 'retailer', 'beat', 'sku', 'distributor']).optional().nullable(),
  entityId: z.string().optional().nullable(),
  entityName: z.string().optional().nullable()
});

export const createActionSchema = z.object({
  type: z.enum(['nudge', 'scheme', 'goal_push', 'collection', 'announcement']),
  title: z.string().min(1),
  status: z.enum(['draft', 'active', 'completed', 'cancelled']).optional().default('draft'),
  sourceKind: z.enum(['signal', 'manual', 'ask', 'goal']).optional().default('manual'),
  sourceKey: z.string().optional().nullable(),
  sourceEntityType: z.string().optional().nullable(),
  sourceEntityId: z.string().optional().nullable(),
  sourceEntityName: z.string().optional().nullable(),
  audienceType: z.enum(['salesman', 'retailer', 'beat', 'sku', 'distributor']).optional().nullable(),
  payload: z.record(z.string(), z.any()).optional(),
  targets: z.array(actionTargetSchema).optional().default([]),
  initialTask: taskPayloadSchema.optional()
});

export const updateActionSchema = z.object({
  title: z.string().min(1).optional(),
  status: z.enum(['draft', 'active', 'completed', 'cancelled']).optional(),
  payload: z.record(z.string(), z.any()).optional()
});

export const actionEventSchema = z.object({
  eventType: z.enum(['created', 'updated', 'status_changed', 'note', 'assign', 'dismissed']),
  label: z.string().min(1),
  detail: z.string().optional().nullable(),
  payload: z.record(z.string(), z.any()).optional(),
  task: taskPayloadSchema.optional()
});

export const actionsListQuerySchema = z.object({
  status: z.enum(['draft', 'active', 'completed', 'cancelled']).optional()
});

export const createTaskSchema = taskPayloadSchema.extend({
  actionId: z.coerce.number().optional().nullable()
});

export const updateTaskSchema = z.object({
  status: z.enum(['open', 'done']).optional(),
  assignee: z.string().min(1).optional(),
  instruction: z.string().min(1).optional(),
  deadline: z.string().optional().nullable()
});

export const trajectoryQuerySchema = z.object({
  entityType: z.string(),
  entityId: z.string(),
  metricKey: z.string(),
  granularity: z.enum(['day', 'week', 'month']).optional().default('month')
});

export const snapshotTimeseriesQuerySchema = z.object({
  entityType: z.string(),
  entityIds: z.union([z.string(), z.array(z.string())]).optional(),
  entityId: z.string().optional(),
  metricKeys: z.union([z.string(), z.array(z.string())]).optional(),
  metricKey: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  granularity: z.enum(['day', 'week', 'month']).optional().default('day'),
  scopeLevel: z.string().optional(),
  scopeValue: z.string().optional(),
  zone: z.string().optional(),
  region: z.string().optional(),
  area: z.string().optional()
});

export const targetTrajectoryQuerySchema = z.object({
  granularity: z.enum(['day', 'week', 'month']).optional().default('day')
});

export const createPersonSchema = z.object({
  personCode: z.string().optional(),
  fullName: z.string().min(1),
  roleCode: z.string().optional(),
  roleName: z.string().optional(),
  zone: z.string().optional(),
  region: z.string().optional(),
  area: z.string().optional(),
  managerPersonId: z.coerce.number().optional()
});

export const createTargetAssignmentSchema = z.object({
  personId: z.coerce.number(),
  targetKey: z.string(),
  assignmentName: z.string().optional(),
  periodGranularity: z.enum(['month', 'quarter']).default('month'),
  periodStartDate: z.string(),
  periodEndDate: z.string(),
  targetValue: z.coerce.number(),
  stretchValue: z.coerce.number().optional(),
  weightage: z.coerce.number().optional()
});

export const legacyCreateTargetSchema = z.object({
  salesmanId: z.union([z.string(), z.number()]).nullable().optional(),
  assignmentEntityType: z.enum(['salesman', 'retailer', 'beat', 'sku', 'distributor']).optional(),
  metric: z.string(),
  baselineValue: z.coerce.number().optional(),
  scope: z
    .object({
      level: z.string().optional(),
      value: z.string().optional()
    })
    .optional(),
  targetValue: z.coerce.number(),
  periodLabel: z.string().optional(),
  startDate: z.string(),
  endDate: z.string(),
  notes: z.string().nullable().optional()
});

export const legacyUpdateTargetSchema = z.object({
  targetValue: z.coerce.number().optional(),
  status: z.enum(['active', 'paused', 'completed']).optional(),
  notes: z.string().nullable().optional()
});

export const importsListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20)
});

export const saveComparePresetSchema = z.object({
  presetName: z.string().min(1),
  compareDimension: z.enum(['geography', 'distributor', 'sku']),
  selectedMetrics: z.array(z.string()).min(1),
  selectedEntities: z.array(z.string()).min(1),
  filters: z.record(z.string(), z.any()).optional()
});
