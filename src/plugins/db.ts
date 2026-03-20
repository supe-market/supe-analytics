import { FastifyInstance } from 'fastify';
import AppDataSource from '../db/data-source';

export async function registerDb(app: FastifyInstance): Promise<void> {
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
