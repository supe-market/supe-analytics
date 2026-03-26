# supe-analytics

Supe Market v1 backend service for supe analytics.

## Stack

- Node.js + TypeScript
- Fastify + Zod
- TypeORM + PostgreSQL
- S3 object storage for raw uploaded files

## Setup

```bash
npm install
cp .env.example .env
```

Supe auth requires a real auth-service user and OAuth client. There is no analytics-side dev auth bypass.

## Run

```bash
npm run dev
```

## Build

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

## Schema-Lock References

- DBML: `docs/schema-lock.dbml`
- Manual load runbook: `docs/manual-data-load-runbook.md`
