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

  AUTH_BYPASS: z.string().optional().default('false'),
  AUTH_BYPASS_USER_ID: z.string().default('dev-supe-user'),
  AUTH_BYPASS_USER_TYPE: z.string().default('supe'),
  AUTH_BYPASS_USER_ROLE: z.string().default('supe'),
  DEV_TENANT_ID: z.string().default('dev-tenant'),

  S3_REGION: z.string().default('ap-south-1'),
  S3_BUCKET: z.string().default(''),
  S3_ENDPOINT: z.string().optional().default(''),
  S3_ACCESS_KEY_ID: z.string().optional().default(''),
  S3_SECRET_ACCESS_KEY: z.string().optional().default(''),
  S3_FORCE_PATH_STYLE: z.string().optional().default('false'),

  DEFAULT_WORKSPACE_ID: z.string().optional(),
  DEFAULT_WORKSPACE_NAME: z.string().default('Default Workspace'),
  IMPORT_MAX_FILE_MB: z.coerce.number().default(25)
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment variables: ${parsed.error.message}`);
}

export const env = {
  ...parsed.data,
  DB_SSL: parsed.data.DB_SSL === 'true',
  AUTH_BYPASS: parsed.data.AUTH_BYPASS === 'true',
  S3_FORCE_PATH_STYLE: parsed.data.S3_FORCE_PATH_STYLE === 'true'
};

export type AppEnv = typeof env;
