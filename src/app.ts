import Fastify from 'fastify';
import { registerCors } from './plugins/cors';
import { registerDb } from './plugins/db';
import { registerAuth } from './plugins/auth';
import { registerApiRoutes } from './routes';
import { buildLogger } from './plugins/logger';
import { registerMultipart } from './plugins/multipart';
import { registerImportWorker } from './plugins/import-worker';

export async function buildApp() {
  const app = Fastify({
    logger: buildLogger()
  });

  await registerCors(app);
  await registerMultipart(app);
  await registerDb(app);
  registerImportWorker(app);
  await registerAuth(app);

  await app.register(async (v1) => {
    await registerApiRoutes(v1);
  }, { prefix: '/api/v1' });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    reply.status(500).send({ success: false, message: 'Internal Server Error' });
  });

  return app;
}
