/**
 * Process entrypoint for the analytics API server.
 */
import { buildApp } from './app';
import { env } from './config/env';

async function bootstrap() {
  /** Build the Fastify app and start listening on the configured host/port. */
  const app = await buildApp();

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
    app.log.info(`supe-analytics listening on ${env.HOST}:${env.PORT}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

bootstrap();
