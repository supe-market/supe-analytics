/**
 * Thin controller layer for the legacy Supe routes.
 *
 * Each method delegates to `SupeService`, then shapes the HTTP response and
 * normalizes user-facing errors.
 */
import { FastifyReply, FastifyRequest } from 'fastify';
import { SupeService } from './service';

export class SupeController {
  /** Bridge Fastify handlers to the service layer. */
  constructor(private readonly service: SupeService) {}

  async getObserveSummary(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    /** Return the dashboard-style observe summary for the current workspace. */
    try {
      const data = await this.service.getObserveSummary(request.query as any, request.user);
      reply.status(200).send({ success: true, data });
    } catch (error: any) {
      reply.status(400).send({ success: false, message: error?.message || 'Bad Request' });
    }
  }

  async getObserveEntityList(
    entityType: 'salesman' | 'retailer' | 'sku' | 'beat' | 'distributor',
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    /** Return a paginated observe list for a single entity type. */
    try {
      const data = await this.service.getObserveEntityList(entityType, request.query as any, request.user);
      reply.status(200).send({ success: true, data: data.data, meta: data.meta });
    } catch (error: any) {
      reply.status(400).send({ success: false, message: error?.message || 'Bad Request' });
    }
  }

  async getObserveEntityInsights(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    /** Return detail metrics for a single observe entity. */
    try {
      const params = request.params as { entityType: any; id: string };
      const data = await this.service.getObserveEntityInsights(params.entityType, params.id, request.query as any, request.user);
      reply.status(200).send({ success: true, data });
    } catch (error: any) {
      reply.status(400).send({ success: false, message: error?.message || 'Bad Request' });
    }
  }

  async listGoals(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const goals = await this.service.listGoals(request.query as any, request.user);
      reply.status(200).send({ success: true, data: { goals } });
    } catch (error: any) {
      reply.status(400).send({ success: false, message: error?.message || 'Bad Request' });
    }
  }

  async createGoal(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const goal = await this.service.createGoal(request.body as any, request.user);
      reply.status(201).send({ success: true, data: { goal } });
    } catch (error: any) {
      reply.status(400).send({ success: false, message: error?.message || 'Bad Request' });
    }
  }

  async updateGoal(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const params = request.params as { id: string };
      const goal = await this.service.updateGoal(params.id, request.body as any, request.user);
      reply.status(200).send({ success: true, data: { goal } });
    } catch (error: any) {
      reply.status(400).send({ success: false, message: error?.message || 'Bad Request' });
    }
  }

  async addGoalSnapshot(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const params = request.params as { id: string };
      const snapshot = await this.service.addGoalSnapshot(params.id, request.body as any, request.user);
      reply.status(201).send({ success: true, data: { snapshot } });
    } catch (error: any) {
      reply.status(400).send({ success: false, message: error?.message || 'Bad Request' });
    }
  }

  async compareEntities(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const data = await this.service.compareEntities(request.body as any, request.user);
      reply.status(200).send({ success: true, data });
    } catch (error: any) {
      reply.status(400).send({ success: false, message: error?.message || 'Bad Request' });
    }
  }

  async compareCohorts(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const data = await this.service.compareCohorts(request.body as any, request.user);
      reply.status(200).send({ success: true, data });
    } catch (error: any) {
      reply.status(400).send({ success: false, message: error?.message || 'Bad Request' });
    }
  }

  async listTargets(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const targets = await this.service.listTargets(request.query as any, request.user);
      reply.status(200).send({ success: true, data: { targets } });
    } catch (error: any) {
      reply.status(400).send({ success: false, message: error?.message || 'Bad Request' });
    }
  }

  async createTarget(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const target = await this.service.createTarget(request.body as any, request.user);
      reply.status(201).send({ success: true, data: { target } });
    } catch (error: any) {
      reply.status(400).send({ success: false, message: error?.message || 'Bad Request' });
    }
  }

  async updateTarget(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const params = request.params as { id: string };
      const target = await this.service.updateTarget(params.id, request.body as any, request.user);
      reply.status(200).send({ success: true, data: { target } });
    } catch (error: any) {
      reply.status(400).send({ success: false, message: error?.message || 'Bad Request' });
    }
  }

  async deleteTarget(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const params = request.params as { id: string };
      await this.service.deleteTarget(params.id, request.query as any, request.user);
      reply.status(200).send({ success: true, message: 'Deleted' });
    } catch (error: any) {
      reply.status(400).send({ success: false, message: error?.message || 'Bad Request' });
    }
  }
}
