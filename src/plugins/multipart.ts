import { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { env } from '../config/env';

export async function registerMultipart(app: FastifyInstance): Promise<void> {
  await app.register(multipart, {
    limits: {
      fileSize: env.IMPORT_MAX_FILE_MB * 1024 * 1024,
      files: 1
    }
  });
}
