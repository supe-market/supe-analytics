import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { env } from '../config/env';
import { InitSupeSchema1710000000000 } from './migrations/1710000000000-InitSupeSchema';
import { ActionWorkflow1710000001000 } from './migrations/1710000001000-ActionWorkflow';
import { AsyncImportPipeline1710000002000 } from './migrations/1710000002000-AsyncImportPipeline';

const AppDataSource = new DataSource({
  type: 'postgres',
  url: env.DATABASE_URL || undefined,
  host: env.DATABASE_URL ? undefined : env.DB_HOST,
  port: env.DATABASE_URL ? undefined : env.DB_PORT,
  username: env.DATABASE_URL ? undefined : env.DB_USER,
  password: env.DATABASE_URL ? undefined : env.DB_PASSWORD,
  database: env.DATABASE_URL ? undefined : env.DB_NAME,
  ssl: env.DB_SSL ? { rejectUnauthorized: false } : false,
  entities: [],
  migrations: [InitSupeSchema1710000000000, ActionWorkflow1710000001000, AsyncImportPipeline1710000002000],
  synchronize: false,
  logging: false
});

export default AppDataSource;
