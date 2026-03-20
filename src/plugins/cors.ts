import { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { env } from '../config/env';

export async function registerCors(app: FastifyInstance): Promise<void> {
  const allowedOrigins = new RegExp(env.ALLOWED_ORIGINS);

  await app.register(cors, {
    credentials: true,
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.test(origin)) {
        cb(null, true);
        return;
      }
      cb(new Error('Not allowed by CORS'), false);
    }
  });
}
