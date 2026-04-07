import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { env } from '../config/env';
import { SupeV1Service } from '../modules/v1/service';

export function registerImportWorker(app: FastifyInstance): void {
  if (!env.IMPORT_WORKER_ENABLED) {
    return;
  }

  const service = new SupeV1Service(app.db);
  const intervalMs = Math.max(env.IMPORT_POLL_INTERVAL_MS, 1000);
  const concurrency = Math.max(1, env.IMPORT_WORKER_CONCURRENCY);
  const intervalIds: NodeJS.Timeout[] = [];
  const workerToken = randomUUID().slice(0, 8);
  const stuckTimeoutMinutes = Number(process.env.IMPORT_STUCK_TIMEOUT_MINUTES || 15);

  // Periodically auto-fail any batch that has been PROCESSING longer than the
  // configured timeout so the UI stops polling forever and the operator can
  // retry.
  const sweeperId = setInterval(() => {
    void service.sweepStuckImports(stuckTimeoutMinutes).catch((err) => {
      app.log.error({ err }, 'import sweeper failed');
    });
  }, 60_000);
  intervalIds.push(sweeperId);

  for (let index = 0; index < concurrency; index += 1) {
    let running = false;
    const workerId = `import-worker:${process.pid}:${workerToken}:${index + 1}`;

    const tick = async () => {
      if (running) {
        return;
      }
      running = true;
      try {
        const processed = await service.processNextQueuedImport(workerId);
        if (processed) {
          app.log.info({ workerId }, 'processed queued import batch');
        }
      } catch (error) {
        app.log.error({ err: error, workerId }, 'import worker tick failed');
      } finally {
        running = false;
      }
    };

    const intervalId = setInterval(() => {
      void tick();
    }, intervalMs);
    intervalIds.push(intervalId);
    void tick();
  }

  app.addHook('onClose', async () => {
    for (const intervalId of intervalIds) {
      clearInterval(intervalId);
    }
  });
}
