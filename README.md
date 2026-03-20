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
- `/api/v1/imports` (strict `.xlsx` + `orders_book` contract)
- `/api/v1/observe/*`
- `/api/v1/signals/*`
- `/api/v1/compare/*`
- `/api/v1/trajectory`
- `/api/v1/targets/*`

## Schema-Lock References

- DBML: `docs/schema-lock.dbml`
- Manual load runbook: `docs/manual-data-load-runbook.md`
