/**
 * Register top-level analytics routes.
 */
import { FastifyInstance } from 'fastify';
import { registerV1Routes } from '../modules/v1/routes';

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  /** Mount the lightweight health route and the versioned product API routes. */
  app.get('/oms', async () => {
    return {
      uptime: process.uptime(),
      message: 'OK',
      timestamp: Date.now()
    };
  });

  await registerV1Routes(app);
}
