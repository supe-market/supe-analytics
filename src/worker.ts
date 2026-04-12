import AppDataSource from './db/data-source';
import pino from 'pino';
import { buildLogger } from './plugins/logger';
import { startImportWorkerRuntime } from './plugins/import-worker-runtime';

async function bootstrap() {
  const logger = pino(buildLogger());
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
  }

  const stopRuntime = startImportWorkerRuntime(AppDataSource, logger);
  logger.info({ pid: process.pid }, 'supe-analytics worker runtime started');

  const shutdown = async () => {
    await stopRuntime();
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });
}

bootstrap().catch((error) => {
  const logger = pino(buildLogger());
  logger.error({ err: error }, 'supe-analytics worker bootstrap failed');
  process.exit(1);
});
