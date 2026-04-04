export type CatalogColumnHint = {
  aliases?: string[];
  semanticRole?: string;
  description?: string;
};

export type CatalogJoinOverride = {
  fromColumn: string;
  toTable: string;
  toColumn: string;
  cardinality?: string;
};

export type CatalogTableHint = {
  description?: string;
  aliases?: string[];
  metricHints?: string[];
  dimensionHints?: string[];
  tenantColumn?: string;
  canonicalDateColumns?: string[];
  joinOverrides?: CatalogJoinOverride[];
  columns?: Record<string, CatalogColumnHint>;
};

export const ASK_CATALOG_MANIFEST: Record<string, CatalogTableHint> = {
  entity_metric_snapshots: {
    description: 'Daily or periodic business KPI snapshots across summary, geography, distributor, beat, retailer, salesman, and SKU entities.',
    aliases: ['metrics', 'kpis', 'metric snapshots', 'analytics snapshots', 'performance snapshots'],
    metricHints: ['revenue', 'sales', 'orders', 'coverage', 'productivity', 'avg line items', 'gmv'],
    dimensionHints: ['entity', 'zone', 'region', 'area', 'time period'],
    tenantColumn: 'tenant_id',
    canonicalDateColumns: ['snapshot_date', 'period_start_date', 'period_end_date'],
    columns: {
      entity_type: { aliases: ['entity', 'level'], semanticRole: 'dimension' },
      entity_name: { aliases: ['name', 'entity name'], semanticRole: 'dimension' },
      metric_key: { aliases: ['metric', 'kpi'], semanticRole: 'dimension' },
      metric_label: { aliases: ['metric label', 'kpi label'], semanticRole: 'dimension' },
      metric_value: { aliases: ['value', 'current value'], semanticRole: 'metric' },
      previous_value: { aliases: ['previous value', 'prior value'], semanticRole: 'metric' },
      snapshot_date: { aliases: ['snapshot date', 'date'], semanticRole: 'date' }
    }
  },
  entity_signals: {
    description: 'Detected business signals and anomalies by entity, with severity, observed values, and detection windows.',
    aliases: ['signals', 'alerts', 'anomalies', 'issues', 'exceptions'],
    metricHints: ['signal severity', 'warning', 'critical', 'opportunity'],
    dimensionHints: ['entity', 'zone', 'region', 'area', 'signal'],
    tenantColumn: 'tenant_id',
    canonicalDateColumns: ['detected_at', 'window_start_date', 'window_end_date'],
    columns: {
      severity: { aliases: ['signal severity'], semanticRole: 'dimension' },
      signal_key: { aliases: ['signal', 'alert key'], semanticRole: 'dimension' },
      detected_at: { aliases: ['detected date', 'detected at'], semanticRole: 'date' },
      observed_value: { aliases: ['observed value'], semanticRole: 'metric' },
      threshold_value: { aliases: ['threshold'], semanticRole: 'metric' }
    }
  },
  sales_orders: {
    description: 'Transactional sales orders and invoice-level financial facts.',
    aliases: ['orders', 'sales', 'invoices', 'billing', 'order facts'],
    metricHints: ['gross amount', 'net amount', 'collections', 'outstanding', 'margin'],
    dimensionHints: ['salesman', 'beat', 'distributor', 'outlet', 'invoice'],
    tenantColumn: 'tenant_id',
    canonicalDateColumns: ['order_sale_date', 'order_punched_at'],
    columns: {
      order_sale_date: { aliases: ['sale date', 'order date'], semanticRole: 'date' },
      order_punched_at: { aliases: ['order punched time'], semanticRole: 'date' },
      gross_amount: { aliases: ['gross sales'], semanticRole: 'metric' },
      net_amount: { aliases: ['net sales', 'revenue'], semanticRole: 'metric' },
      collections_amount: { aliases: ['collections'], semanticRole: 'metric' },
      outstanding_amount: { aliases: ['outstanding'], semanticRole: 'metric' }
    }
  },
  sales_order_items: {
    description: 'Line-item level sales order details by SKU.',
    aliases: ['order items', 'line items', 'invoice items'],
    metricHints: ['quantity', 'amount', 'discount', 'tax'],
    dimensionHints: ['sku', 'line item'],
    columns: {
      ordered_quantity: { aliases: ['quantity', 'qty'], semanticRole: 'metric' },
      amount: { aliases: ['line amount'], semanticRole: 'metric' },
      sku_id: { aliases: ['sku'], semanticRole: 'identifier' }
    }
  },
  target_progress_snapshots: {
    description: 'Progress against target assignments over time.',
    aliases: ['target progress', 'goal progress', 'target snapshots'],
    metricHints: ['progress', 'target attainment', 'variance'],
    dimensionHints: ['assignee', 'target', 'status'],
    tenantColumn: 'tenant_id',
    canonicalDateColumns: ['snapshot_date'],
    columns: {
      actual_value: { aliases: ['actual'], semanticRole: 'metric' },
      target_value: { aliases: ['target'], semanticRole: 'metric' },
      progress_pct: { aliases: ['progress percent', 'attainment'], semanticRole: 'metric' },
      variance_value: { aliases: ['variance'], semanticRole: 'metric' }
    }
  },
  target_assignments: {
    description: 'Assigned goals and targets for people and scopes.',
    aliases: ['targets', 'goals', 'target assignments'],
    metricHints: ['target value', 'baseline', 'stretch value'],
    dimensionHints: ['person', 'scope', 'period', 'status'],
    tenantColumn: 'tenant_id',
    canonicalDateColumns: ['period_start_date', 'period_end_date'],
    columns: {
      assignment_name: { aliases: ['target name', 'goal name'], semanticRole: 'dimension' },
      target_value: { aliases: ['target'], semanticRole: 'metric' },
      baseline_value: { aliases: ['baseline'], semanticRole: 'metric' },
      scope_level: { aliases: ['scope level'], semanticRole: 'dimension' },
      scope_value: { aliases: ['scope'], semanticRole: 'dimension' }
    }
  },
  salesmen: {
    description: 'Salesman master data with geography and distributor assignment.',
    aliases: ['sales reps', 'salesmen', 'field reps'],
    dimensionHints: ['salesman', 'region', 'area', 'distributor'],
    tenantColumn: 'tenant_id',
    columns: {
      salesman_name: { aliases: ['salesman', 'rep name'], semanticRole: 'dimension' },
      distributor_id: { aliases: ['assigned distributor'], semanticRole: 'identifier' }
    }
  },
  distributors: {
    description: 'Distributor master data with zone, region, and area.',
    aliases: ['distributors', 'stockists'],
    dimensionHints: ['distributor', 'zone', 'region', 'area'],
    tenantColumn: 'tenant_id',
    columns: {
      distributor_name: { aliases: ['distributor'], semanticRole: 'dimension' }
    }
  },
  beats: {
    description: 'Beat master data mapped to distributors and geography.',
    aliases: ['beats', 'routes', 'beat routes'],
    dimensionHints: ['beat', 'route', 'sales route'],
    tenantColumn: 'tenant_id',
    columns: {
      beat_name: { aliases: ['beat', 'route'], semanticRole: 'dimension' }
    }
  },
  tenant_outlets: {
    description: 'Tenant-specific outlet assignments, servicing status, and ownership.',
    aliases: ['retailers', 'outlets', 'stores', 'shops'],
    dimensionHints: ['retailer', 'store', 'outlet', 'servicing'],
    tenantColumn: 'tenant_id',
    canonicalDateColumns: ['first_order_date', 'last_order_date'],
    columns: {
      tenant_outlet_code: { aliases: ['retailer code', 'outlet code'], semanticRole: 'dimension' },
      servicing_status: { aliases: ['status', 'servicing status'], semanticRole: 'dimension' },
      first_order_date: { aliases: ['first order date'], semanticRole: 'date' },
      last_order_date: { aliases: ['last order date'], semanticRole: 'date' }
    }
  },
  skus: {
    description: 'SKU master data including brand and pricing attributes.',
    aliases: ['sku', 'skus', 'products', 'items'],
    metricHints: ['mrp', 'rate', 'amount'],
    dimensionHints: ['product', 'brand', 'hsn'],
    tenantColumn: 'tenant_id',
    columns: {
      name: { aliases: ['sku name', 'product name'], semanticRole: 'dimension' },
      mrp: { aliases: ['mrp'], semanticRole: 'metric' },
      rate: { aliases: ['rate', 'price'], semanticRole: 'metric' }
    }
  },
  actions: {
    description: 'Action plans created from signals or manual workflows.',
    aliases: ['actions', 'tasks', 'plans'],
    dimensionHints: ['action', 'status', 'source'],
    tenantColumn: 'tenant_id'
  },
  action_tasks: {
    description: 'Execution tasks associated with actions.',
    aliases: ['action tasks', 'followups', 'task list'],
    dimensionHints: ['task', 'assignee', 'status'],
    tenantColumn: 'tenant_id',
    canonicalDateColumns: ['deadline'],
    columns: {
      deadline: { aliases: ['due date'], semanticRole: 'date' },
      status: { aliases: ['task status'], semanticRole: 'dimension' }
    }
  }
};
