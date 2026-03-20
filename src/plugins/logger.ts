import { FastifyInstance } from 'fastify';
import pino from 'pino';
import { env } from '../config/env';

export function buildLogger() {
  return pino({
    level: env.NODE_ENV === 'development' ? 'debug' : 'info',
    transport:
      env.NODE_ENV === 'development'
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss'
            }
          }
        : undefined
  });
}

export async function registerLogger(app: FastifyInstance): Promise<void> {
  app.log.info('Logger initialized');
}
