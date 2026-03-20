import { z } from 'zod';

export const observeEntityQuerySchema = z.object({
  companyId: z.string().optional(),
  workspaceId: z.string().optional(),
  timeRange: z.enum(['today', 'mtd', 'last7d', 'last30d', 'last90d', 'thisQuarter']).optional().default('last30d'),
  period: z.string().optional(),
  zone: z.string().optional(),
  region: z.string().optional(),
  area: z.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(500).optional().default(50)
});

export const createGoalSchema = z.object({
  companyId: z.string().optional(),
  workspaceId: z.string().optional(),
  name: z.string().min(1).max(160),
  metricKey: z.string().max(80),
  geoKey: z.string().max(120),
  baseline: z.number(),
  target: z.number(),
  startDate: z.string(),
  endDate: z.string()
});

export const updateGoalSchema = z.object({
  companyId: z.string().optional(),
  workspaceId: z.string().optional(),
  status: z.enum(['active', 'completed', 'paused', 'archived']).optional(),
  current: z.number().optional()
});

export const addGoalSnapshotSchema = z.object({
  companyId: z.string().optional(),
  workspaceId: z.string().optional(),
  weekNumber: z.number().int().min(1),
  actualValue: z.number(),
  snapshotDate: z.string().optional()
});

export const compareEntitiesSchema = z.object({
  companyId: z.string().optional(),
  workspaceId: z.string().optional(),
  entityType: z.enum(['salesman', 'retailer', 'sku', 'beat', 'distributor']),
  entityIds: z.array(z.string()).min(2),
  metrics: z.array(z.string()).min(1),
  period: z.string().optional(),
  timeRange: z.enum(['today', 'mtd', 'last7d', 'last30d', 'last90d', 'thisQuarter']).optional().default('last30d')
});

export const createTargetSchema = z.object({
  companyId: z.string().optional(),
  workspaceId: z.string().optional(),
  salesmanId: z.string().nullable().optional(),
  metric: z.string().max(80),
  scope: z.object({
    level: z.string(),
    value: z.string()
  }),
  targetValue: z.number(),
  period: z.string().optional().nullable(),
  periodLabel: z.string().max(80),
  startDate: z.string(),
  endDate: z.string(),
  notes: z.string().nullable().optional()
});

export const updateTargetSchema = z.object({
  companyId: z.string().optional(),
  workspaceId: z.string().optional(),
  targetValue: z.number().optional(),
  notes: z.string().nullable().optional(),
  status: z.enum(['active', 'paused', 'completed']).optional()
});

export const compareCohortsSchema = z.object({
  companyId: z.string().optional(),
  workspaceId: z.string().optional(),
  entityType: z.enum(['salesman', 'retailer', 'sku', 'beat', 'distributor']),
  cohort1: z.string(),
  cohort2: z.string(),
  metrics: z.array(z.string()).min(1),
  period: z.string().optional(),
  timeRange: z.enum(['today', 'mtd', 'last7d', 'last30d', 'last90d', 'thisQuarter']).optional().default('last30d')
});
