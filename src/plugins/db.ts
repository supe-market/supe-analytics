/**
 * Fastify plugin that exposes the shared TypeORM data source on the app.
 */
import { FastifyInstance } from 'fastify';
import AppDataSource from '../db/data-source';

export async function registerDb(app: FastifyInstance): Promise<void> {
  /** Initialize the DB once and tear it down when Fastify closes. */
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
  }

  app.decorate('db', AppDataSource);

  app.addHook('onClose', async () => {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
  });
}
