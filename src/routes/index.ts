import { FastifyInstance } from 'fastify';
import { registerV1Routes } from '../modules/v1/routes';

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/oms', async () => {
    return {
      uptime: process.uptime(),
      message: 'OK',
      timestamp: Date.now()
    };
  });

  await registerV1Routes(app);
}
