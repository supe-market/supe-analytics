import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

function parsePostgresUrl(rawUrl: string | undefined) {
  if (!rawUrl) {
    return null;
  }

  try {
    const parsed = new URL(rawUrl);
    return {
      host: parsed.hostname || 'localhost',
      port: parsed.port ? Number(parsed.port) : 5432,
      user: decodeURIComponent(parsed.username || 'postgres'),
      password: decodeURIComponent(parsed.password || 'postgres'),
      name: parsed.pathname.replace(/^\//, '') || 'supe_analytics'
    };
  } catch {
    return null;
  }
}

const parsedDatabaseUrl = parsePostgresUrl(process.env.DATABASE_URL || process.env.DB_URL);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().default(3010),
  COOKIE_SECRET: z.string().default('supe-analytics-cookie-secret'),
  ALLOWED_ORIGINS: z.string().default('.*'),

  DATABASE_URL: z.string().optional().default(process.env.DATABASE_URL || process.env.DB_URL || ''),
  DB_HOST: z.string().default(parsedDatabaseUrl?.host || 'localhost'),
  DB_PORT: z.coerce.number().default(parsedDatabaseUrl?.port || 5432),
  DB_USER: z.string().default(parsedDatabaseUrl?.user || 'postgres'),
  DB_PASSWORD: z.string().default(parsedDatabaseUrl?.password || 'postgres'),
  DB_NAME: z.string().default(parsedDatabaseUrl?.name || 'supe_analytics'),
  DB_SSL: z.string().optional().default('false'),

  UMS_AUTH_URL: z.string().default('http://localhost:3201/api/v1'),
  UMS_AUTH_PARAM: z.string().default(''),

  S3_REGION: z.string().default('ap-south-1'),
  S3_BUCKET: z.string().default(''),
  S3_ENDPOINT: z.string().optional().default(''),
  S3_ACCESS_KEY_ID: z.string().optional().default(''),
  S3_SECRET_ACCESS_KEY: z.string().optional().default(''),
  S3_FORCE_PATH_STYLE: z.string().optional().default('false'),

  ASK_REDIS_URL: z.string().optional(),
  ASK_REDIS_HOST: z.string().optional(),
  ASK_REDIS_PORT: z.coerce.number().default(6379),
  ASK_REDIS_DB: z.coerce.number().default(0),
  ASK_REDIS_USERNAME: z.string().optional(),
  ASK_REDIS_PASSWORD: z.string().optional(),
  REDIS_HOST: z.string().optional(),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  ASK_GRAPH_CACHE_TTL_SECONDS: z.coerce.number().default(43200),

  DEFAULT_WORKSPACE_ID: z.string().optional(),
  DEFAULT_WORKSPACE_NAME: z.string().default('Default Workspace'),
  IMPORT_MAX_FILE_MB: z.coerce.number().default(25),
  IMPORT_WORKER_ENABLED: z.string().optional().default('false'),
  IMPORT_POLL_INTERVAL_MS: z.coerce.number().default(5000),
  IMPORT_WORKER_CONCURRENCY: z.coerce.number().default(1)
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment variables: ${parsed.error.message}`);
}

export const env = {
  ...parsed.data,
  DB_SSL: parsed.data.DB_SSL === 'true',
  S3_FORCE_PATH_STYLE: parsed.data.S3_FORCE_PATH_STYLE === 'true',
  IMPORT_WORKER_ENABLED: parsed.data.IMPORT_WORKER_ENABLED === 'true'
};

export type AppEnv = typeof env;
