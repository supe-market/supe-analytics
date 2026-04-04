/**
 * Fastify application factory for supe-analytics.
 *
 * The app is assembled from small plugins so auth, DB lifecycle, uploads, and
 * API routes stay separately testable.
 */
import Fastify from 'fastify';
import { registerCors } from './plugins/cors';
import { registerDb } from './plugins/db';
import { registerAuth } from './plugins/auth';
import { registerApiRoutes } from './routes';
import { buildLogger } from './plugins/logger';
import { registerMultipart } from './plugins/multipart';
import { registerImportWorker } from './plugins/import-worker';

export async function buildApp() {
  /** Create and configure the analytics Fastify instance. */
  const app = Fastify({
    logger: buildLogger()
  });

  await registerCors(app);
  await registerMultipart(app);
  await registerDb(app);
  registerImportWorker(app);
  await registerAuth(app);

  // All product APIs are mounted under the v1 prefix. Health and process wiring
  // stay outside this file in `server.ts`.
  await app.register(async (v1) => {
    await registerApiRoutes(v1);
  }, { prefix: '/api/v1' });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    reply.status(500).send({ success: false, message: 'Internal Server Error' });
  });

  return app;
}
