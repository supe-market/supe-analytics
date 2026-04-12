import { FastifyInstance } from 'fastify';
import { env } from '../config/env';
import { startImportWorkerRuntime } from './import-worker-runtime';

export function registerImportWorker(app: FastifyInstance): void {
  if (!env.IMPORT_WORKER_ENABLED) {
    return;
  }
  const stopRuntime = startImportWorkerRuntime(app.db, app.log);

  app.addHook('onClose', async () => {
    await stopRuntime();
  });
}
