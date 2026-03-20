import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { env } from '../config/env';
import { InitSupeSchema1710000000000 } from './migrations/1710000000000-InitSupeSchema';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: env.DB_HOST,
  port: env.DB_PORT,
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  ssl: env.DB_SSL ? { rejectUnauthorized: false } : false,
  entities: [],
  migrations: [InitSupeSchema1710000000000],
  synchronize: false,
  logging: false
});

export default AppDataSource;
