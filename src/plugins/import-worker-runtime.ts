import { randomUUID } from 'crypto';
import type { DataSource } from 'typeorm';
import { env } from '../config/env';
import { SupeV1Service } from '../modules/v1/service';

type LoggerLike = {
  info: (payload: Record<string, unknown>, message: string) => void;
  error: (payload: Record<string, unknown>, message: string) => void;
};

export function startImportWorkerRuntime(db: DataSource, logger: LoggerLike): () => Promise<void> {
  const service = new SupeV1Service(db);
  const intervalMs = Math.max(env.IMPORT_POLL_INTERVAL_MS, 1000);
  const concurrency = Math.max(1, env.IMPORT_WORKER_CONCURRENCY);
  const intervalIds: NodeJS.Timeout[] = [];
  const workerToken = randomUUID().slice(0, 8);
  const stuckTimeoutMinutes = Number(process.env.IMPORT_STUCK_TIMEOUT_MINUTES || 15);

  const sweeperId = setInterval(() => {
    void service.sweepStuckImports(stuckTimeoutMinutes).catch((err) => {
      logger.error({ err }, 'import sweeper failed');
    });
  }, 60_000);
  intervalIds.push(sweeperId);

  for (let index = 0; index < concurrency; index += 1) {
    let importRunning = false;
    const workerId = `import-worker:${process.pid}:${workerToken}:${index + 1}`;
    const refreshWorkerId = `refresh-worker:${process.pid}:${workerToken}:${index + 1}`;

    const importTick = async () => {
      if (importRunning) {
        return;
      }
      importRunning = true;
      try {
        const processed = await service.processNextQueuedImport(workerId);
        if (processed) {
          logger.info({ workerId }, 'processed queued import batch');
        }
      } catch (error) {
        logger.error({ err: error, workerId }, 'import worker tick failed');
      } finally {
        importRunning = false;
      }
    };

    let refreshRunning = false;
    const refreshTick = async () => {
      if (refreshRunning) {
        return;
      }
      refreshRunning = true;
      try {
        const processed = await service.processNextQueuedRefreshJob(refreshWorkerId);
        if (processed) {
          logger.info({ refreshWorkerId }, 'processed queued tenant refresh job');
        }
      } catch (error) {
        logger.error({ err: error, refreshWorkerId }, 'tenant refresh worker tick failed');
      } finally {
        refreshRunning = false;
      }
    };

    const intervalId = setInterval(() => {
      void importTick();
    }, intervalMs);
    intervalIds.push(intervalId);
    void importTick();

    const refreshIntervalId = setInterval(() => {
      void refreshTick();
    }, intervalMs);
    intervalIds.push(refreshIntervalId);
    void refreshTick();
  }

  return async () => {
    for (const intervalId of intervalIds) {
      clearInterval(intervalId);
    }
  };
}
