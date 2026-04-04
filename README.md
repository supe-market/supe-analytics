# supe-analytics

Supe Market analytics API.

## Responsibilities

- serve the Supe analytics API
- verify Supe auth sessions through `auth-service`
- queue and process import uploads
- persist analytics data in PostgreSQL
- store raw import files in S3 when imports are enabled

## Local Development

```bash
npm install
cp .env.example .env
npm run dev
```

This service depends on:

- PostgreSQL reachable through `DATABASE_URL` or the fallback `DB_*` variables
- a reachable `auth-service`
- `UMS_AUTH_PARAM` from the auth bootstrap flow
- S3 only if you are testing imports

There is no analytics-side auth bypass.

## Build and Run

```bash
npm run build
npm start
```

## Migrations

```bash
npm run typeorm:migrate
npm run typeorm:revert
```

## API Base

- `/api/v1/cookie`
- `/api/v1/oms/cookie`
- `/api/v1/imports` (strict `.xlsx` + `orders_book` contract, async batch processing)
- `/api/v1/imports/template`
- `/api/v1/observe/*`
- `/api/v1/signals/*`
- `/api/v1/compare/*`
- `/api/v1/trajectory`
- `/api/v1/targets/*`

## Imports

- Supports only strict `.xlsx` uploads using the `orders_book` sheet.
- CSV, `.xls`, alternate sheet names, and source-mapping are not supported.
- Uploads are queued and processed by the background import worker.
- S3 object storage is required because queued imports are processed after the request completes.
- In both dev and prod, PostgreSQL can stay outside Docker as long as the configured database URL is reachable from the container or process.

## Reference Assets

- DBML: `docs/schema-lock.dbml`
