# Manual Data Load Runbook (Schema-Lock Phase)

## Scope
- Ingestion API supports strict `orders_book` `.xlsx` uploads.
- Manual SQL/scripts remain a fallback for direct data correction.

## Import Contract (When Ingestion Is Enabled)
- Accept only `.xlsx` files.
- Sheet name must be exactly `orders_book`.
- Header names must exactly match the finalized template.
- `S.no` is required in template for user readability and row-level error reporting, but ignored for writes.

## Minimum Insert Order
1. `tenants`
2. `distributors`
3. `beats`
4. `salesmen`
5. `outlets`
6. `beat_outlets` (active beat membership)
7. `tenant_outlets`
8. `brands`
9. `skus`
10. `sales_orders`
11. `sales_order_items`
12. `order_payments` (optional)
13. `signal_definitions`
14. `tenant_signal_thresholds`
15. `people` (if targets are used)
16. `target_definitions`, `target_assignments`

## Minimum Required Columns by Table
- `tenants`: `tenant_code`, `tenant_name`
- `distributors`: `tenant_id`, `distributor_code`, `distributor_name`
- `beats`: `tenant_id`, `beat_code`, `beat_name`
- `salesmen`: `tenant_id`, `salesman_code`, `salesman_name`
- `outlets`: `outlet_name`
- `beat_outlets`: `tenant_id`, `beat_id`, `outlet_id`, `active`
- `tenant_outlets`: `tenant_id`, `outlet_id`, `tenant_outlet_code`
- `brands`: `tenant_id`, `brand_name`
- `skus`: `tenant_id`, `sku_code`, `name`
- `sales_orders`: `tenant_id`, `outlet_id`
- `sales_order_items`: `sales_order_id`, `sku_id`, `ordered_quantity`

## Signal Threshold Rules
- `tenant_signal_thresholds.zone` must be uppercase and zone-specific or `NATIONAL` fallback.
- Runtime signal evaluation resolves threshold in this order:
1. exact entity zone
2. `NATIONAL`

## Sanity Checks
```sql
-- One active beat per outlet per tenant
select tenant_id, outlet_id, count(*)
from beat_outlets
where active = true
group by tenant_id, outlet_id
having count(*) > 1;

-- SKU uniqueness
select tenant_id, sku_code, count(*)
from skus
group by tenant_id, sku_code
having count(*) > 1;

-- Threshold uniqueness
select tenant_id, signal_definition_id, upper(zone), count(*)
from tenant_signal_thresholds
group by tenant_id, signal_definition_id, upper(zone)
having count(*) > 1;
```

## Post-Load Ops
1. Recompute snapshots through service flow used by your environment.
2. Trigger signal evaluation endpoint.
3. Trigger targets recompute endpoint.
