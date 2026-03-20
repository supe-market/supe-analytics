import { DataSource } from 'typeorm';
import { FastifyReply, FastifyRequest } from 'fastify';
import { IAuthUser } from './index';

declare module 'fastify' {
  interface FastifyRequest {
    user?: IAuthUser;
    unsignCookie: (value: string) => { valid: boolean; renew: boolean; value: string | null };
  }

  interface FastifyInstance {
    db: DataSource;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
