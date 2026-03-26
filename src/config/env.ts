import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().default(3010),
  COOKIE_SECRET: z.string().default('supe-analytics-cookie-secret'),
  ALLOWED_ORIGINS: z.string().default('.*'),

  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().default(5432),
  DB_USER: z.string().default('postgres'),
  DB_PASSWORD: z.string().default('postgres'),
  DB_NAME: z.string().default('supe_analytics'),
  DB_SSL: z.string().optional().default('false'),

  UMS_AUTH_URL: z.string().default('http://localhost:3201/api/v1'),
  UMS_AUTH_PARAM: z.string().default(''),

  S3_REGION: z.string().default('ap-south-1'),
  S3_BUCKET: z.string().default(''),
  S3_ENDPOINT: z.string().optional().default(''),
  S3_ACCESS_KEY_ID: z.string().optional().default(''),
  S3_SECRET_ACCESS_KEY: z.string().optional().default(''),
  S3_FORCE_PATH_STYLE: z.string().optional().default('false'),

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
