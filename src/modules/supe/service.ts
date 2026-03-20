import { DataSource } from 'typeorm';
import { SupeEntityType, IAuthUser } from '../../types';
import { LdrCanonicalEvent, LdrEntity, LdrTarget } from '../../db/entities';
import { EGoalStatus, ESupeEntityType, ETargetStatus } from '../../db/entities/supeTypes';
import {
  daysBetweenDates,
  formatDateParts,
  formatISTDate,
  getCurrentISTDate,
  getDateParts,
  shiftDate,
  startOfMonth
} from '../../utils/ist-date';
import { SupeRepository } from './repository';

interface ITimeRange {
  fromDate: string;
  toDate: string;
  previousFromDate: string;
  previousToDate: string;
}

interface IEntityMetricRow {
  id: string;
  name: string;
  zone: string | null;
  region: string | null;
  area: string | null;
  rawEntity: LdrEntity;
  metrics: Record<string, number | string | null>;
}

function parseNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatIndianNumber(value: number, decimals = 0): string {
  return value.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0
  }).format(value || 0);
}

function toIstDate(value: string | Date): string {
  if (typeof value === 'string') {
    const directMatch = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (directMatch) {
      return directMatch[1];
    }
  }

  const date = value instanceof Date ? value : new Date(value);
  return formatISTDate(date);
}

function daysBetween(fromDate: Date, toDate: Date): number {
  const diff = toDate.getTime() - fromDate.getTime();
  return Math.max(Math.floor(diff / 86400000), 0);
}

function getRangeFromQuery(timeRange?: string, period?: string): ITimeRange {
  const toDate = getCurrentISTDate();
  let fromDate = toDate;
  const range = timeRange || period || 'last30d';
  const { year, quarter } = getDateParts(toDate);

  switch (range) {
    case 'today':
      break;
    case 'mtd':
      fromDate = startOfMonth(toDate);
      break;
    case 'last7d':
      fromDate = shiftDate(toDate, -7);
      break;
    case 'last90d':
      fromDate = shiftDate(toDate, -90);
      break;
    case 'thisQuarter': {
      fromDate = formatDateParts(year, (quarter - 1) * 3 + 1, 1);
      break;
    }
    case 'last30d':
    default:
      fromDate = shiftDate(toDate, -30);
      break;
  }

  const spanDays = Math.max(daysBetweenDates(fromDate, toDate), 0) + 1;
  const previousToDate = shiftDate(fromDate, -1);
  const previousFromDate = shiftDate(previousToDate, -(spanDays - 1));

  return {
    fromDate,
    toDate,
    previousFromDate,
    previousToDate
  };
}

function getEntityIdByType(event: LdrCanonicalEvent, entityType: SupeEntityType): string | null {
  switch (entityType) {
    case 'salesman':
      return event.salesmanEntityId || null;
    case 'retailer':
      return event.retailerEntityId || null;
    case 'sku':
      return event.skuEntityId || null;
    case 'beat':
      return event.beatEntityId || null;
    case 'distributor':
      return event.distributorEntityId || null;
    default:
      return null;
  }
}

function getMeasure(event: LdrCanonicalEvent, key: string): number {
  const data = (event.measuresJson || {}) as Record<string, unknown>;
  if (data[key] !== undefined) {
    return parseNumber(data[key]);
  }

  const snake = key.replace(/[A-Z]/g, (value) => `_${value.toLowerCase()}`);
  if (data[snake] !== undefined) {
    return parseNumber(data[snake]);
  }

  return 0;
}

function getAttrsString(entity: LdrEntity, key: string): string | null {
  const value = (entity.attrsJson || {})[key];
  return value === null || value === undefined || value === '' ? null : String(value);
}

export class SupeService {
  private readonly repository: SupeRepository;

  constructor(private readonly db: DataSource) {
    this.repository = new SupeRepository(db);
  }

  private async resolveWorkspace(query: Record<string, unknown>, user?: IAuthUser): Promise<string> {
    const companyId = query.companyId ? String(query.companyId) : undefined;
    const workspaceId = query.workspaceId ? String(query.workspaceId) : undefined;

    return this.repository.resolveWorkspaceId({
      workspaceId,
      companyId,
      userId: user?.id
    });
  }

  private sortRows(rows: IEntityMetricRow[], sortBy?: string, sortOrder: 'asc' | 'desc' = 'desc'): IEntityMetricRow[] {
    const key = sortBy || 'revenue';
    return [...rows].sort((a, b) => {
      const aValue = parseNumber(a.metrics[key]);
      const bValue = parseNumber(b.metrics[key]);
      if (sortOrder === 'asc') {
        return aValue - bValue;
      }
      return bValue - aValue;
    });
  }

  private paginateRows<T>(rows: T[], page: number, limit: number): { data: T[]; meta: any } {
    const safePage = Math.max(page, 1);
    const safeLimit = Math.max(limit, 1);
    const offset = (safePage - 1) * safeLimit;
    const data = rows.slice(offset, offset + safeLimit);

    return {
      data,
      meta: {
        page: safePage,
        limit: safeLimit,
        total: rows.length,
        totalPages: Math.max(Math.ceil(rows.length / safeLimit), 1)
      }
    };
  }

  private getDefaultMetricsRow(entity: LdrEntity): IEntityMetricRow {
    return {
      id: entity.id,
      name: entity.displayName,
      zone: entity.geoZone || null,
      region: entity.geoRegion || null,
      area: entity.geoArea || null,
      rawEntity: entity,
      metrics: {
        revenue: 0,
        orders: 0,
        collection: 0,
        coveragePct: 0,
        beatAdherencePct: 0,
        outstanding: 0,
        aov: 0,
        dormancyDays: 0,
        lastOrderAt: null,
        totalRetailers: 0,
        realizationPct: 0,
        visits: 0,
        ebv: 0,
        units: 0,
        outlets: 0,
        penetrationPct: 0,
        growthPct: 0,
        fulfilmentPct: 0,
        damageRate: 0,
        damage: 0
      }
    };
  }

  private async computeEntityRows(
    entityType: SupeEntityType,
    workspaceId: string,
    range: ITimeRange,
    geo?: { zone?: string; region?: string; area?: string }
  ): Promise<IEntityMetricRow[]> {
    const entities = await this.repository.listEntitiesByType(workspaceId, entityType as ESupeEntityType, geo);
    if (!entities.length) {
      return [];
    }

    const [currentEvents, previousEvents, relations, allRetailers] = await Promise.all([
      this.repository.listCanonicalEvents(workspaceId, range.fromDate, range.toDate),
      this.repository.listCanonicalEvents(workspaceId, range.previousFromDate, range.previousToDate),
      this.repository.listEntityRelations(workspaceId),
      this.repository.listEntitiesByType(workspaceId, ESupeEntityType.RETAILER)
    ]);

    const entityRows = new Map<string, IEntityMetricRow>();
    entities.forEach((entity) => entityRows.set(entity.id, this.getDefaultMetricsRow(entity)));

    const retailerUniverseCount = allRetailers.length;
    const currentDate = getCurrentISTDate();

    const currentEventsByEntity = new Map<string, LdrCanonicalEvent[]>();
    for (const event of currentEvents) {
      const entityId = getEntityIdByType(event, entityType);
      if (!entityId || !entityRows.has(entityId)) {
        continue;
      }
      const list = currentEventsByEntity.get(entityId) || [];
      list.push(event);
      currentEventsByEntity.set(entityId, list);
    }

    const previousEventsByEntity = new Map<string, LdrCanonicalEvent[]>();
    for (const event of previousEvents) {
      const entityId = getEntityIdByType(event, entityType);
      if (!entityId || !entityRows.has(entityId)) {
        continue;
      }
      const list = previousEventsByEntity.get(entityId) || [];
      list.push(event);
      previousEventsByEntity.set(entityId, list);
    }

    for (const [entityId, row] of entityRows.entries()) {
      const events = currentEventsByEntity.get(entityId) || [];
      const previous = previousEventsByEntity.get(entityId) || [];

      const invoiceSet = new Set<string>();
      const retailerSet = new Set<string>();
      const beatSet = new Set<string>();
      let revenue = 0;
      let saleAmount = 0;
      let returnAmount = 0;
      let units = 0;
      let lastDate: Date | null = null;

      for (const event of events) {
        const invoice = event.invoiceId || event.billNo || event.eventKey;
        invoiceSet.add(invoice);
        if (event.retailerEntityId) {
          retailerSet.add(event.retailerEntityId);
        }
        if (event.beatEntityId) {
          beatSet.add(event.beatEntityId);
        }

        const eventRevenue = getMeasure(event, 'netSaleAmount');
        const eventSale = getMeasure(event, 'saleAmount');
        const eventReturn = Math.abs(getMeasure(event, 'saleReturnAmount'));
        const eventUnits = getMeasure(event, 'netSaleQuantity');

        revenue += eventRevenue;
        saleAmount += Math.abs(eventSale);
        returnAmount += eventReturn;
        units += eventUnits;

        const eventDate = new Date(`${event.eventDate}T00:00:00.000Z`);
        if (!lastDate || eventDate.getTime() > lastDate.getTime()) {
          lastDate = eventDate;
        }
      }

      let previousRevenue = 0;
      for (const event of previous) {
        previousRevenue += getMeasure(event, 'netSaleAmount');
      }

      const orders = invoiceSet.size;
      const avgOrderValue = orders > 0 ? revenue / orders : 0;
      const growthPct = previousRevenue > 0 ? ((revenue - previousRevenue) * 100) / previousRevenue : revenue > 0 ? 100 : 0;
      const damageRate = saleAmount > 0 ? (returnAmount * 100) / saleAmount : 0;
      const fulfillment = Math.max(0, Math.min(100, 100 - damageRate));

      row.metrics.revenue = Number(revenue.toFixed(2));
      row.metrics.orders = orders;
      row.metrics.collection = Number(revenue.toFixed(2));
      row.metrics.aov = Number(avgOrderValue.toFixed(2));
      row.metrics.units = Number(units.toFixed(2));
      row.metrics.outlets = retailerSet.size;
      row.metrics.growthPct = Number(growthPct.toFixed(2));
      row.metrics.damageRate = Number(damageRate.toFixed(2));
      row.metrics.damage = Number(damageRate.toFixed(2));
      row.metrics.fulfilmentPct = Number(fulfillment.toFixed(2));
      row.metrics.realizationPct = saleAmount > 0 ? Number(((revenue * 100) / saleAmount).toFixed(2)) : 0;
      row.metrics.visits = orders;
      row.metrics.ebv = orders > 0 ? Number((revenue / orders).toFixed(2)) : 0;
      row.metrics.lastOrderAt = lastDate ? lastDate.toISOString() : null;
      row.metrics.dormancyDays = lastDate ? daysBetweenDates(toIstDate(lastDate), currentDate) : 999;
      row.metrics.penetrationPct = retailerUniverseCount > 0 ? Number(((retailerSet.size * 100) / retailerUniverseCount).toFixed(2)) : 0;

      if (entityType === 'salesman') {
        const assignedRetailers = new Set(
          relations
            .filter((relation) => relation.relationType === 'salesman_retailer' && relation.parentEntityId === entityId)
            .map((relation) => relation.childEntityId)
        );

        const assignedBeats = new Set(
          relations
            .filter((relation) => relation.relationType === 'salesman_beat' && relation.parentEntityId === entityId)
            .map((relation) => relation.childEntityId)
        );

        row.metrics.coveragePct =
          assignedRetailers.size > 0 ? Number(((retailerSet.size * 100) / assignedRetailers.size).toFixed(2)) : retailerSet.size > 0 ? 100 : 0;
        row.metrics.beatAdherencePct =
          assignedBeats.size > 0 ? Number(((beatSet.size * 100) / assignedBeats.size).toFixed(2)) : beatSet.size > 0 ? 100 : 0;
      }

      if (entityType === 'beat') {
        const assignedRetailers = new Set(
          relations
            .filter((relation) => relation.relationType === 'beat_retailer' && relation.parentEntityId === entityId)
            .map((relation) => relation.childEntityId)
        );

        row.metrics.totalRetailers = assignedRetailers.size;
        row.metrics.coveragePct =
          assignedRetailers.size > 0 ? Number(((retailerSet.size * 100) / assignedRetailers.size).toFixed(2)) : retailerSet.size > 0 ? 100 : 0;
      }

      if (entityType === 'sku') {
        row.metrics.penetrationPct = retailerUniverseCount > 0 ? Number(((retailerSet.size * 100) / retailerUniverseCount).toFixed(2)) : 0;
      }
    }

    return Array.from(entityRows.values());
  }

  private mapRowForApi(entityType: SupeEntityType, row: IEntityMetricRow): Record<string, unknown> {
    const attrs = row.rawEntity.attrsJson as Record<string, unknown>;

    if (entityType === 'salesman') {
      return {
        salesmanId: row.id,
        firstName: row.name,
        lastName: '',
        zone: row.zone,
        region: row.region,
        area: row.area,
        metrics: {
          revenueMTD: row.metrics.revenue || 0,
          ordersMTD: row.metrics.orders || 0,
          collectionMTD: row.metrics.collection || 0,
          activeRetailersMTD: row.metrics.outlets || 0,
          coveragePct: row.metrics.coveragePct || 0,
          beatAdherencePct: row.metrics.beatAdherencePct || 0,
          outstandingAmount: row.metrics.outstanding || 0
        }
      };
    }

    if (entityType === 'retailer') {
      return {
        retailerId: row.id,
        firstName: row.name,
        lastName: '',
        zone: row.zone,
        city: row.region,
        area: row.area,
        metrics: {
          revenueMTD: row.metrics.revenue || 0,
          ordersMTD: row.metrics.orders || 0,
          aovMTD: row.metrics.aov || 0,
          outstandingAmount: row.metrics.outstanding || 0,
          daysSinceOrder: row.metrics.dormancyDays || 0,
          lastOrderAt: row.metrics.lastOrderAt || null
        }
      };
    }

    if (entityType === 'beat') {
      return {
        beatId: row.id,
        beatCode: getAttrsString(row.rawEntity, 'beatCode') || row.id,
        beatName: row.name,
        zone: row.zone,
        region: row.region,
        area: row.area,
        metrics: {
          totalRetailers: row.metrics.totalRetailers || 0,
          revenueMTD: row.metrics.revenue || 0,
          coveragePct: row.metrics.coveragePct || 0,
          realizationPct: row.metrics.realizationPct || 0,
          visitsMTD: row.metrics.visits || 0,
          ebv: row.metrics.ebv || 0
        }
      };
    }

    if (entityType === 'sku') {
      return {
        skuId: row.id,
        sku: getAttrsString(row.rawEntity, 'skuCode') || row.id,
        skuName: row.name,
        category: getAttrsString(row.rawEntity, 'category') || getAttrsString(row.rawEntity, 'segment') || '-',
        zone: row.zone,
        region: row.region,
        area: row.area,
        metrics: {
          revenueMTD: row.metrics.revenue || 0,
          unitsMTD: row.metrics.units || 0,
          outletsMTD: row.metrics.outlets || 0,
          penetrationPct: row.metrics.penetrationPct || 0,
          growthPct: row.metrics.growthPct || 0
        }
      };
    }

    return {
      distributorId: row.id,
      distributorName: row.name,
      zone: row.zone,
      region: row.region,
      area: row.area,
      metrics: {
        revenueMTD: row.metrics.revenue || 0,
        ordersMTD: row.metrics.orders || 0,
        fulfilmentPct: row.metrics.fulfilmentPct || 0,
        damageRate: row.metrics.damageRate || 0
      }
    };
  }

  private calculateMetricValueFromEntityRow(row: IEntityMetricRow, metric: string): number {
    switch (metric) {
      case 'revenue':
        return parseNumber(row.metrics.revenue);
      case 'collection':
        return parseNumber(row.metrics.collection);
      case 'orders':
        return parseNumber(row.metrics.orders);
      case 'coverage':
        return parseNumber(row.metrics.coveragePct);
      case 'beat_adherence':
        return parseNumber(row.metrics.beatAdherencePct);
      case 'outstanding':
      case 'outstanding_reduction':
        return parseNumber(row.metrics.outstanding);
      case 'aov':
        return parseNumber(row.metrics.aov);
      case 'realizationPct':
        return parseNumber(row.metrics.realizationPct);
      case 'qty':
      case 'units':
        return parseNumber(row.metrics.units);
      case 'penetration':
        return parseNumber(row.metrics.penetrationPct);
      case 'growth':
        return parseNumber(row.metrics.growthPct);
      case 'fulfilmentRate':
        return parseNumber(row.metrics.fulfilmentPct);
      case 'damage':
        return parseNumber(row.metrics.damageRate);
      default:
        return parseNumber(row.metrics[metric]);
    }
  }

  private toGeo(query: Record<string, unknown>): { zone?: string; region?: string; area?: string } {
    const zone = query.zone ? String(query.zone) : undefined;
    const region = query.region ? String(query.region) : undefined;
    const area = query.area ? String(query.area) : undefined;

    return { zone, region, area };
  }

  async getObserveEntityList(entityType: SupeEntityType, query: Record<string, unknown>, user?: IAuthUser): Promise<any> {
    const workspaceId = await this.resolveWorkspace(query, user);
    const range = getRangeFromQuery(String(query.timeRange || ''), String(query.period || ''));
    const geo = this.toGeo(query);

    const rows = await this.computeEntityRows(entityType, workspaceId, range, geo);
    const sorted = this.sortRows(rows, query.sortBy ? String(query.sortBy) : undefined, (query.sortOrder as 'asc' | 'desc') || 'desc');
    const paginated = this.paginateRows(sorted, parseNumber(query.page) || 1, parseNumber(query.limit) || 50);

    return {
      data: paginated.data.map((row) => this.mapRowForApi(entityType, row)),
      meta: paginated.meta
    };
  }

  async getObserveSummary(query: Record<string, unknown>, user?: IAuthUser): Promise<any> {
    const workspaceId = await this.resolveWorkspace(query, user);
    const range = getRangeFromQuery(String(query.timeRange || ''), String(query.period || ''));
    const geo = this.toGeo(query);

    const [salesmanRows, retailerRows, skuRows, beatRows, distributorRows, goals] = await Promise.all([
      this.computeEntityRows('salesman', workspaceId, range, geo),
      this.computeEntityRows('retailer', workspaceId, range, geo),
      this.computeEntityRows('sku', workspaceId, range, geo),
      this.computeEntityRows('beat', workspaceId, range, geo),
      this.computeEntityRows('distributor', workspaceId, range, geo),
      this.repository.listGoals(workspaceId)
    ]);

    const revenueCurrent = salesmanRows.reduce((sum, row) => sum + parseNumber(row.metrics.revenue), 0);
    const collectionCurrent = salesmanRows.reduce((sum, row) => sum + parseNumber(row.metrics.collection), 0);
    const outstandingCurrent = retailerRows.reduce((sum, row) => sum + parseNumber(row.metrics.outstanding), 0);
    const avgCoverage = salesmanRows.length
      ? salesmanRows.reduce((sum, row) => sum + parseNumber(row.metrics.coveragePct), 0) / salesmanRows.length
      : 0;
    const avgAdherence = salesmanRows.length
      ? salesmanRows.reduce((sum, row) => sum + parseNumber(row.metrics.beatAdherencePct), 0) / salesmanRows.length
      : 0;

    const currentDate = getCurrentISTDate();
    const dayElapsed = Math.max(1, daysBetweenDates(range.fromDate, currentDate) + 1);
    const daysInPeriod = Math.max(1, daysBetweenDates(range.fromDate, range.toDate) + 1);
    const currentDateParts = getDateParts(currentDate);
    const quarter = `Q${currentDateParts.quarter} FY${String(currentDateParts.year).slice(-2)}`;

    const metricCards = [
      {
        key: 'revenue',
        title: 'Revenue',
        value: formatCurrency(revenueCurrent),
        subtitle: 'Net sales in selected period',
        note: `${formatIndianNumber(salesmanRows.length)} salesmen`,
        accent: '#2563eb'
      },
      {
        key: 'collection',
        title: 'Collection',
        value: formatCurrency(collectionCurrent),
        subtitle: 'Estimated collections',
        note: `${formatIndianNumber(retailerRows.length)} retailers`,
        accent: '#16a34a'
      },
      {
        key: 'outstanding',
        title: 'Outstanding',
        value: formatCurrency(outstandingCurrent),
        subtitle: 'Outstanding amount',
        note: `${formatIndianNumber(retailerRows.filter((row) => parseNumber(row.metrics.outstanding) > 0).length)} retailers`,
        accent: '#dc2626'
      },
      {
        key: 'coverage',
        title: 'Coverage',
        value: `${formatIndianNumber(avgCoverage, 1)}%`,
        subtitle: 'Average coverage across salesmen',
        note: `${formatIndianNumber(salesmanRows.length)} salesmen`,
        accent: avgCoverage >= 60 ? '#16a34a' : '#d97706'
      },
      {
        key: 'adherence',
        title: 'Beat Adherence',
        value: `${formatIndianNumber(avgAdherence, 1)}%`,
        subtitle: 'Average beat adherence',
        note: `${formatIndianNumber(beatRows.length)} beats`,
        accent: avgAdherence >= 70 ? '#16a34a' : '#d97706'
      }
    ];

    const activeGoals = goals
      .filter((goal) => goal.status === EGoalStatus.ACTIVE)
      .slice(0, 4)
      .map((goal) => {
        const baseline = parseNumber(goal.baseline);
        const target = parseNumber(goal.target);
        const current = parseNumber(goal.current);
        const denominator = target - baseline;
        const progressPercent = denominator > 0 ? ((current - baseline) * 100) / denominator : 0;
        const daysLeft = Math.max(0, daysBetweenDates(currentDate, toIstDate(goal.endDate)));
        const statusLabel = progressPercent >= 90 ? 'On Track' : progressPercent >= 60 ? 'Moderately Lagging' : 'Stalled';

        return {
          id: goal.id,
          name: goal.name,
          status: statusLabel,
          statusColor: progressPercent >= 90 ? 'green' : progressPercent >= 60 ? 'orange' : 'red',
          baseline: formatCurrency(baseline),
          target: formatCurrency(target),
          current: formatCurrency(current),
          value: Math.max(0, Math.min(100, Number(progressPercent.toFixed(2)))),
          daysLeft: `${daysLeft} days left`,
          accent: progressPercent >= 90 ? '#16a34a' : progressPercent >= 60 ? '#d97706' : '#dc2626'
        };
      });

    const worstCoverage = [...salesmanRows].sort((a, b) => parseNumber(a.metrics.coveragePct) - parseNumber(b.metrics.coveragePct))[0];
    const dormantRetailers = retailerRows.filter((row) => parseNumber(row.metrics.dormancyDays) > 14);
    const worstSku = [...skuRows].sort((a, b) => parseNumber(a.metrics.growthPct) - parseNumber(b.metrics.growthPct))[0];

    const periodIntelligence = [
      worstCoverage
        ? {
            key: 'coverage-drop',
            type: parseNumber(worstCoverage.metrics.coveragePct) < 60 ? 'negative' : 'positive',
            label: 'Coverage risk at',
            detail: `${worstCoverage.name} (${formatIndianNumber(parseNumber(worstCoverage.metrics.coveragePct), 1)}%)`,
            action: 'View salesman'
          }
        : null,
      dormantRetailers.length
        ? {
            key: 'dormant-retailers',
            type: 'negative',
            label: 'Dormant retailers',
            detail: `${formatIndianNumber(dormantRetailers.length)} retailers inactive >14 days`,
            action: 'View retailers'
          }
        : null,
      worstSku
        ? {
            key: 'sku-risk',
            type: parseNumber(worstSku.metrics.growthPct) < 0 ? 'negative' : 'positive',
            label: 'SKU growth signal',
            detail: `${worstSku.name} (${formatIndianNumber(parseNumber(worstSku.metrics.growthPct), 1)}%)`,
            action: 'View SKU'
          }
        : null
    ].filter(Boolean);

    const entityPulseCards = [
      {
        key: 'salesman',
        title: 'Salesman',
        labelOne: 'Active',
        valueOne: String(salesmanRows.filter((row) => parseNumber(row.metrics.orders) > 0).length),
        labelTwo: 'Total',
        valueTwo: String(salesmanRows.length),
        labelThree: 'Avg Coverage',
        valueThree: `${formatIndianNumber(avgCoverage, 1)}%`,
        indicator: avgCoverage >= 60 ? 'warning' : 'critical',
        footnote: `${salesmanRows.length} total salesmen in view`
      },
      {
        key: 'retailer',
        title: 'Retailer',
        labelOne: 'Active',
        valueOne: String(retailerRows.filter((row) => parseNumber(row.metrics.orders) > 0).length),
        labelTwo: 'Total',
        valueTwo: String(retailerRows.length),
        labelThree: 'Dormant',
        valueThree: String(dormantRetailers.length),
        indicator: dormantRetailers.length > 0 ? 'critical' : 'warning',
        footnote: `${dormantRetailers.length} dormant retailers above threshold`
      },
      {
        key: 'sku',
        title: 'SKU',
        labelOne: 'Total',
        valueOne: String(skuRows.length),
        labelTwo: 'Top SKU',
        valueTwo: String([...skuRows].sort((a, b) => parseNumber(b.metrics.revenue) - parseNumber(a.metrics.revenue))[0]?.name || '-'),
        labelThree: 'Negative Growth',
        valueThree: String(skuRows.filter((row) => parseNumber(row.metrics.growthPct) < 0).length),
        indicator: skuRows.some((row) => parseNumber(row.metrics.growthPct) < 0) ? 'critical' : 'warning',
        footnote: 'Growth compared to previous period'
      },
      {
        key: 'distributor',
        title: 'Distributor',
        labelOne: 'Active',
        valueOne: String(distributorRows.filter((row) => parseNumber(row.metrics.orders) > 0).length),
        labelTwo: 'Total',
        valueTwo: String(distributorRows.length),
        labelThree: 'High Damage',
        valueThree: String(distributorRows.filter((row) => parseNumber(row.metrics.damageRate) > 5).length),
        indicator: distributorRows.some((row) => parseNumber(row.metrics.damageRate) > 5) ? 'critical' : 'warning',
        footnote: 'Damage is derived from return to sale ratio'
      },
      {
        key: 'beat',
        title: 'Beat',
        labelOne: 'Total',
        valueOne: String(beatRows.length),
        labelTwo: 'Avg Realization',
        valueTwo: `${formatIndianNumber(
          beatRows.length
            ? beatRows.reduce((sum, row) => sum + parseNumber(row.metrics.realizationPct), 0) / beatRows.length
            : 0,
          1
        )}%`,
        labelThree: 'Low Coverage',
        valueThree: String(beatRows.filter((row) => parseNumber(row.metrics.coveragePct) < 60).length),
        indicator: beatRows.some((row) => parseNumber(row.metrics.coveragePct) < 60) ? 'critical' : 'warning',
        footnote: 'Beat health from assigned vs active retailers'
      }
    ];

    const intelligence = periodIntelligence.map((item, index) => ({
      id: `signal-${index + 1}`,
      title: item?.label,
      detail: item?.detail,
      severity: item?.type === 'negative' ? 'warning' : 'opportunity'
    }));

    return {
      period: {
        label: String(query.timeRange || 'last30d').toUpperCase(),
        dayElapsed,
        daysInPeriod,
        quarter
      },
      intelligence,
      summarySection: {
        metricCards,
        goals: activeGoals,
        periodIntelligence,
        entityPulseCards
      }
    };
  }

  async getObserveEntityInsights(
    entityType: SupeEntityType,
    id: string,
    query: Record<string, unknown>,
    user?: IAuthUser
  ): Promise<any> {
    const workspaceId = await this.resolveWorkspace(query, user);
    const range = getRangeFromQuery(String(query.timeRange || ''), String(query.period || ''));

    const rows = await this.computeEntityRows(entityType, workspaceId, range);
    const row = rows.find((item) => item.id === id);
    if (!row) {
      throw new Error('Entity not found');
    }

    const events = await this.repository.listCanonicalEvents(workspaceId, range.fromDate, range.toDate);
    const entityEvents = events.filter((event) => getEntityIdByType(event, entityType) === id);

    const trendMap = new Map<string, { revenue: number; qty: number; orders: Set<string> }>();
    for (const event of entityEvents) {
      const key = event.eventDate;
      const current = trendMap.get(key) || { revenue: 0, qty: 0, orders: new Set<string>() };
      current.revenue += getMeasure(event, 'netSaleAmount');
      current.qty += getMeasure(event, 'netSaleQuantity');
      current.orders.add(event.invoiceId || event.billNo || event.eventKey);
      trendMap.set(key, current);
    }

    const trends = Array.from(trendMap.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([date, aggregate]) => [
        { date, metric: 'revenue', value: Number(aggregate.revenue.toFixed(2)) },
        { date, metric: 'qty', value: Number(aggregate.qty.toFixed(2)) },
        { date, metric: 'orders', value: aggregate.orders.size }
      ]);

    const insights: Array<{ id: string; title: string; detail: string; severity: string }> = [];

    if (parseNumber(row.metrics.coveragePct) < 60) {
      insights.push({
        id: 'low-coverage',
        title: 'Low coverage',
        detail: `Coverage is ${formatIndianNumber(parseNumber(row.metrics.coveragePct), 1)}%`,
        severity: 'warning'
      });
    }

    if (parseNumber(row.metrics.growthPct) < 0) {
      insights.push({
        id: 'negative-growth',
        title: 'Negative growth',
        detail: `Growth is ${formatIndianNumber(parseNumber(row.metrics.growthPct), 1)}% vs previous period`,
        severity: 'warning'
      });
    }

    if (parseNumber(row.metrics.damageRate) > 5) {
      insights.push({
        id: 'high-damage',
        title: 'High damage risk',
        detail: `Damage rate is ${formatIndianNumber(parseNumber(row.metrics.damageRate), 1)}%`,
        severity: 'critical'
      });
    }

    if (!insights.length) {
      insights.push({
        id: 'stable',
        title: 'Stable performance',
        detail: 'No major risk signal in selected period',
        severity: 'opportunity'
      });
    }

    return {
      insights,
      trends
    };
  }

  async compareEntities(payload: Record<string, unknown>, user?: IAuthUser): Promise<any> {
    const workspaceId = await this.resolveWorkspace(payload, user);
    const entityType = String(payload.entityType) as SupeEntityType;
    const range = getRangeFromQuery(String(payload.timeRange || ''), String(payload.period || ''));
    const entityIds = Array.isArray(payload.entityIds) ? payload.entityIds.map((id) => String(id)) : [];
    const metrics = Array.isArray(payload.metrics) ? payload.metrics.map((metric) => String(metric)) : [];

    const rows = await this.computeEntityRows(entityType, workspaceId, range);
    const selected = rows.filter((row) => entityIds.includes(row.id));

    const entities = selected.map((row) => {
      const metricValues: Record<string, number> = {};
      for (const metric of metrics) {
        metricValues[metric] = Number(this.calculateMetricValueFromEntityRow(row, metric).toFixed(2));
      }

      return {
        id: row.id,
        name: row.name,
        metrics: metricValues
      };
    });

    const summary = metrics.map((metric) => {
      const values = entities.map((entity) => parseNumber(entity.metrics[metric]));
      const total = values.reduce((sum, value) => sum + value, 0);
      const average = values.length ? total / values.length : 0;
      const min = values.length ? Math.min(...values) : 0;
      const max = values.length ? Math.max(...values) : 0;

      return {
        metric,
        average: Number(average.toFixed(2)),
        min: Number(min.toFixed(2)),
        max: Number(max.toFixed(2))
      };
    });

    return { entities, summary };
  }

  async compareCohorts(payload: Record<string, unknown>, user?: IAuthUser): Promise<any> {
    const workspaceId = await this.resolveWorkspace(payload, user);
    const entityType = String(payload.entityType) as SupeEntityType;
    const metrics = Array.isArray(payload.metrics) ? payload.metrics.map((item) => String(item)) : [];
    const range = getRangeFromQuery(String(payload.timeRange || ''), String(payload.period || ''));

    const [cohortOne, cohortTwo] = await Promise.all([
      this.repository.getCohortById(workspaceId, String(payload.cohort1)),
      this.repository.getCohortById(workspaceId, String(payload.cohort2))
    ]);

    if (!cohortOne || !cohortTwo) {
      throw new Error('Cohort not found');
    }

    const rows = await this.computeEntityRows(entityType, workspaceId, range);
    const rowMap = new Map(rows.map((row) => [row.id, row]));

    const evaluateCohort = (entityIds: string[]): Record<string, number> => {
      const filtered = entityIds
        .map((id) => rowMap.get(id))
        .filter((value): value is IEntityMetricRow => Boolean(value));

      const result: Record<string, number> = {};
      for (const metric of metrics) {
        const values = filtered.map((row) => this.calculateMetricValueFromEntityRow(row, metric));
        if (['coverage', 'beat_adherence', 'growth', 'penetration', 'realizationPct', 'damage', 'fulfilmentRate'].includes(metric)) {
          const avg = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
          result[metric] = Number(avg.toFixed(2));
        } else {
          result[metric] = Number(values.reduce((sum, value) => sum + value, 0).toFixed(2));
        }
      }

      return result;
    };

    return {
      cohort1: {
        id: cohortOne.id,
        name: cohortOne.name,
        metrics: evaluateCohort(cohortOne.entityIds || [])
      },
      cohort2: {
        id: cohortTwo.id,
        name: cohortTwo.name,
        metrics: evaluateCohort(cohortTwo.entityIds || [])
      }
    };
  }

  async listGoals(query: Record<string, unknown>, user?: IAuthUser): Promise<any[]> {
    const workspaceId = await this.resolveWorkspace(query, user);
    const goals = await this.repository.listGoals(workspaceId);
    const snapshots = await this.repository.listGoalSnapshots(workspaceId, goals.map((goal) => goal.id));

    const groupedSnapshots = new Map<string, any[]>();
    for (const snapshot of snapshots) {
      const list = groupedSnapshots.get(snapshot.goalId) || [];
      list.push(snapshot);
      groupedSnapshots.set(snapshot.goalId, list);
    }

    return goals.map((goal) => {
      const baseline = parseNumber(goal.baseline);
      const target = parseNumber(goal.target);
      const current = parseNumber(goal.current);
      const denominator = target - baseline;
      const progressPercent = denominator > 0 ? ((current - baseline) * 100) / denominator : 0;

      return {
        id: goal.id,
        name: goal.name,
        metricKey: goal.metricKey,
        geoKey: goal.geoKey,
        baseline,
        target,
        current,
        status: goal.status,
        startDate: goal.startDate,
        endDate: goal.endDate,
        progressPercent: Number(progressPercent.toFixed(2)),
        snapshots: (groupedSnapshots.get(goal.id) || []).map((snapshot) => ({
          id: snapshot.id,
          weekNumber: snapshot.weekNumber,
          requiredValue: parseNumber(snapshot.requiredValue),
          actualValue: parseNumber(snapshot.actualValue),
          snapshotDate: snapshot.snapshotDate
        }))
      };
    });
  }

  async createGoal(payload: Record<string, unknown>, user?: IAuthUser): Promise<any> {
    const workspaceId = await this.resolveWorkspace(payload, user);

    const goal = await this.repository.createGoal({
      workspaceId,
      name: String(payload.name),
      metricKey: String(payload.metricKey),
      geoKey: String(payload.geoKey || 'all_india'),
      baseline: String(parseNumber(payload.baseline)),
      target: String(parseNumber(payload.target)),
      current: String(parseNumber(payload.baseline)),
      status: EGoalStatus.ACTIVE,
      startDate: String(payload.startDate).slice(0, 10),
      endDate: String(payload.endDate).slice(0, 10),
      createdBy: user?.id || 'system'
    });

    return {
      id: goal.id,
      name: goal.name,
      metricKey: goal.metricKey,
      geoKey: goal.geoKey,
      baseline: parseNumber(goal.baseline),
      target: parseNumber(goal.target),
      current: parseNumber(goal.current),
      status: goal.status,
      startDate: goal.startDate,
      endDate: goal.endDate,
      progressPercent: 0,
      snapshots: []
    };
  }

  async updateGoal(id: string, payload: Record<string, unknown>, user?: IAuthUser): Promise<any> {
    const workspaceId = await this.resolveWorkspace(payload, user);
    const goal = await this.repository.getGoalById(workspaceId, id);
    if (!goal) {
      throw new Error('Goal not found');
    }

    if (payload.status) {
      goal.status = String(payload.status) as EGoalStatus;
    }
    if (payload.current !== undefined) {
      goal.current = String(parseNumber(payload.current));
    }

    const saved = await this.repository.saveGoal(goal);
    const baseline = parseNumber(saved.baseline);
    const target = parseNumber(saved.target);
    const current = parseNumber(saved.current);
    const denominator = target - baseline;
    const progressPercent = denominator > 0 ? ((current - baseline) * 100) / denominator : 0;

    return {
      id: saved.id,
      name: saved.name,
      metricKey: saved.metricKey,
      geoKey: saved.geoKey,
      baseline,
      target,
      current,
      status: saved.status,
      startDate: saved.startDate,
      endDate: saved.endDate,
      progressPercent: Number(progressPercent.toFixed(2))
    };
  }

  async addGoalSnapshot(goalId: string, payload: Record<string, unknown>, user?: IAuthUser): Promise<any> {
    const workspaceId = await this.resolveWorkspace(payload, user);
    const goal = await this.repository.getGoalById(workspaceId, goalId);
    if (!goal) {
      throw new Error('Goal not found');
    }

    const weekNumber = parseNumber(payload.weekNumber);
    const actualValue = parseNumber(payload.actualValue);
    const snapshotDate = payload.snapshotDate ? toIstDate(String(payload.snapshotDate)) : getCurrentISTDate();

    const baseline = parseNumber(goal.baseline);
    const target = parseNumber(goal.target);
    const totalWeeks = Math.max(1, Math.ceil(daysBetween(new Date(goal.startDate), new Date(goal.endDate)) / 7));
    const requiredValue = baseline + ((target - baseline) * Math.min(weekNumber, totalWeeks)) / totalWeeks;

    const snapshot = await this.repository.createGoalSnapshot({
      workspaceId,
      goalId,
      weekNumber,
      actualValue: String(actualValue),
      requiredValue: String(Number(requiredValue.toFixed(2))),
      snapshotDate
    });

    if (actualValue > parseNumber(goal.current)) {
      goal.current = String(actualValue);
      await this.repository.saveGoal(goal);
    }

    return {
      id: snapshot.id,
      weekNumber: snapshot.weekNumber,
      requiredValue: parseNumber(snapshot.requiredValue),
      actualValue: parseNumber(snapshot.actualValue),
      snapshotDate: snapshot.snapshotDate
    };
  }

  private async computeTargetActualValue(workspaceId: string, target: LdrTarget): Promise<number> {
    const range: ITimeRange = {
      fromDate: target.startDate,
      toDate: target.endDate,
      previousFromDate: target.startDate,
      previousToDate: target.endDate
    };

    const geo: { zone?: string; region?: string; area?: string } = {};
    if (target.scopeLevel === 'zone') {
      geo.zone = target.scopeValue;
    }
    if (target.scopeLevel === 'region') {
      geo.region = target.scopeValue;
    }
    if (target.scopeLevel === 'area') {
      geo.area = target.scopeValue;
    }

    const rows = await this.computeEntityRows('salesman', workspaceId, range, geo);
    const filteredRows = target.salesmanId ? rows.filter((row) => row.id === target.salesmanId) : rows;

    if (!filteredRows.length) {
      return 0;
    }

    const values = filteredRows.map((row) => this.calculateMetricValueFromEntityRow(row, target.metric));

    if (['coverage', 'beat_adherence', 'growth', 'penetration', 'realizationPct', 'damage', 'fulfilmentRate'].includes(target.metric)) {
      return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
    }

    return Number(values.reduce((sum, value) => sum + value, 0).toFixed(2));
  }

  async listTargets(query: Record<string, unknown>, user?: IAuthUser): Promise<any[]> {
    const workspaceId = await this.resolveWorkspace(query, user);
    const targets = await this.repository.listTargets(workspaceId);

    const response: any[] = [];
    for (const target of targets) {
      const actualValue = await this.computeTargetActualValue(workspaceId, target);
      const targetValue = parseNumber(target.targetValue);
      const attainmentPct = targetValue > 0 ? (actualValue * 100) / targetValue : 0;

      target.actualValue = String(actualValue);
      await this.repository.saveTarget(target);

      response.push({
        id: target.id,
        salesmanId: target.salesmanId,
        metric: target.metric,
        scopeLevel: target.scopeLevel,
        scopeValue: target.scopeValue,
        targetValue,
        actualValue,
        attainmentPct: Number(attainmentPct.toFixed(2)),
        period: target.period,
        periodLabel: target.periodLabel,
        startDate: target.startDate,
        endDate: target.endDate,
        notes: target.notes,
        status: target.status,
        createdAt: target.createdAt,
        updatedAt: target.updatedAt
      });
    }

    return response;
  }

  async createTarget(payload: Record<string, unknown>, user?: IAuthUser): Promise<any> {
    const workspaceId = await this.resolveWorkspace(payload, user);

    const created = await this.repository.createTarget({
      workspaceId,
      salesmanId: payload.salesmanId ? String(payload.salesmanId) : null,
      metric: String(payload.metric),
      scopeLevel: String((payload.scope as any)?.level || 'national'),
      scopeValue: String((payload.scope as any)?.value || 'all_india'),
      targetValue: String(parseNumber(payload.targetValue)),
      actualValue: '0',
      period: payload.period ? String(payload.period) : null,
      periodLabel: String(payload.periodLabel),
      startDate: String(payload.startDate).slice(0, 10),
      endDate: String(payload.endDate).slice(0, 10),
      notes: payload.notes ? String(payload.notes) : null,
      status: ETargetStatus.ACTIVE,
      createdBy: user?.id || 'system'
    });

    return {
      id: created.id,
      salesmanId: created.salesmanId,
      metric: created.metric,
      scopeLevel: created.scopeLevel,
      scopeValue: created.scopeValue,
      targetValue: parseNumber(created.targetValue),
      actualValue: parseNumber(created.actualValue),
      attainmentPct: 0,
      period: created.period,
      periodLabel: created.periodLabel,
      startDate: created.startDate,
      endDate: created.endDate,
      notes: created.notes,
      status: created.status
    };
  }

  async updateTarget(targetId: string, payload: Record<string, unknown>, user?: IAuthUser): Promise<any> {
    const workspaceId = await this.resolveWorkspace(payload, user);
    const target = await this.repository.getTargetById(workspaceId, targetId);
    if (!target) {
      throw new Error('Target not found');
    }

    if (payload.targetValue !== undefined) {
      target.targetValue = String(parseNumber(payload.targetValue));
    }
    if (payload.notes !== undefined) {
      target.notes = payload.notes ? String(payload.notes) : null;
    }
    if (payload.status) {
      target.status = String(payload.status) as ETargetStatus;
    }

    const saved = await this.repository.saveTarget(target);
    const actualValue = await this.computeTargetActualValue(workspaceId, saved);
    const targetValue = parseNumber(saved.targetValue);
    const attainmentPct = targetValue > 0 ? (actualValue * 100) / targetValue : 0;

    saved.actualValue = String(actualValue);
    await this.repository.saveTarget(saved);

    return {
      id: saved.id,
      salesmanId: saved.salesmanId,
      metric: saved.metric,
      scopeLevel: saved.scopeLevel,
      scopeValue: saved.scopeValue,
      targetValue,
      actualValue,
      attainmentPct: Number(attainmentPct.toFixed(2)),
      period: saved.period,
      periodLabel: saved.periodLabel,
      startDate: saved.startDate,
      endDate: saved.endDate,
      notes: saved.notes,
      status: saved.status
    };
  }

  async deleteTarget(targetId: string, query: Record<string, unknown>, user?: IAuthUser): Promise<void> {
    const workspaceId = await this.resolveWorkspace(query, user);
    const target = await this.repository.getTargetById(workspaceId, targetId);
    if (!target) {
      throw new Error('Target not found');
    }

    await this.repository.softDeleteTarget(target);
  }
}
