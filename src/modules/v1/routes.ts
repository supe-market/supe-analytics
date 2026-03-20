import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { SupeV1Service } from './service';
import {
  compareRunSchema,
  createPersonSchema,
  createTargetAssignmentSchema,
  importMetaSchema,
  observeDetailQuerySchema,
  legacyCreateTargetSchema,
  legacyUpdateTargetSchema,
  observeEntityTypeSchema,
  observeListQuerySchema,
  saveComparePresetSchema,
  signalDefaultsSchema,
  signalOverridesSchema,
  trajectoryQuerySchema
} from './schemas';

function parseSchema<T>(schema: z.ZodSchema<T>, payload: unknown): T {
  try {
    return schema.parse(payload);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(error.issues[0]?.message || 'Validation failed');
    }
    throw error;
  }
}

function parseImportMeta(fileFields: Record<string, any> | undefined): { sourceCode?: string; sourceSheetName?: string } {
  const sourceCode = fileFields?.sourceCode?.value ? String(fileFields.sourceCode.value) : undefined;
  const sourceSheetName = fileFields?.sourceSheetName?.value ? String(fileFields.sourceSheetName.value) : undefined;
  return parseSchema(importMetaSchema, { sourceCode, sourceSheetName });
}

async function routeWrap(reply: FastifyReply, callback: () => Promise<void>): Promise<void> {
  try {
    await callback();
  } catch (error: any) {
    reply.status(Number(error?.statusCode || 400)).send({
      success: false,
      message: error?.message || 'Bad Request',
      details: error?.details || undefined,
      batchId: error?.batchId || undefined
    });
  }
}

export async function registerV1Routes(app: FastifyInstance): Promise<void> {
  const service = new SupeV1Service(app.db);

  app.post('/imports', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const multipartFile = await (request as any).file();
      if (!multipartFile) {
        throw new Error('file is required');
      }
      const meta = parseImportMeta(multipartFile.fields);
      const result = await service.createImport(request.user, multipartFile, meta);
      reply.status(201).send({ success: true, data: result });
    });
  });

  app.get('/imports/:id', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const params = request.params as { id: string };
      const result = await service.getImportById(request.user, Number(params.id));
      reply.status(200).send({ success: true, data: result });
    });
  });

  app.get('/observe/summary', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const data = await service.getObserveSummary(request.user);
      reply.status(200).send({ success: true, data });
    });
  });

  app.get('/observe/:entityType', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const params = request.params as { entityType: string };
      const parsedEntityType = parseSchema(observeEntityTypeSchema, params.entityType);
      const query = parseSchema(observeListQuerySchema, request.query);
      const result = await service.listObserveEntity(parsedEntityType, request.user, query);
      reply.status(200).send({ success: true, data: result.data, meta: result.meta });
    });
  });

  app.get('/observe/:entityType/:id', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const params = request.params as { entityType: string; id: string };
      const entityType = parseSchema(observeEntityTypeSchema, params.entityType);
      const query = parseSchema(observeDetailQuerySchema, request.query);
      const result = await service.getObserveEntityDetails(entityType, params.id, request.user, query.timeRange);
      reply.status(200).send({ success: true, data: result });
    });
  });

  app.get('/observe/:entityType/:id/insights', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const params = request.params as { entityType: string; id: string };
      const entityType = parseSchema(observeEntityTypeSchema, params.entityType);
      const query = parseSchema(observeDetailQuerySchema, request.query);
      const result = await service.getObserveEntityDetails(entityType, params.id, request.user, query.timeRange);
      reply.status(200).send({ success: true, data: result });
    });
  });

  app.get('/signals', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const query = request.query as { entityType?: string; severity?: string };
      const data = await service.listSignals(request.user, query);
      reply.status(200).send({ success: true, data });
    });
  });

  app.get('/signals/:entityType/:id', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const params = request.params as { entityType: string; id: string };
      const entityType = parseSchema(observeEntityTypeSchema, params.entityType);
      const data = await service.getEntitySignals(request.user, entityType, params.id);
      reply.status(200).send({ success: true, data });
    });
  });

  app.get('/signals/config', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const data = await service.getSignalConfig(request.user);
      reply.status(200).send({ success: true, data });
    });
  });

  app.put('/signals/config/defaults', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const body = parseSchema(signalDefaultsSchema, request.body);
      await service.updateSignalDefaults(request.user, body.defaults);
      reply.status(200).send({ success: true });
    });
  });

  app.put('/signals/config/overrides', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const body = parseSchema(signalOverridesSchema, request.body);
      await service.updateSignalOverrides(request.user, body.overrides);
      reply.status(200).send({ success: true });
    });
  });

  app.post('/signals/config/reset', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      await service.resetSignalConfig(request.user, true);
      reply.status(200).send({ success: true });
    });
  });

  app.post('/signals/evaluate', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const runId = await service.evaluateSignals(request.user);
      reply.status(200).send({ success: true, data: { runId } });
    });
  });

  app.post('/compare/run', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const body = parseSchema(compareRunSchema, request.body);
      const data = await service.runCompare(request.user, body);
      reply.status(200).send({ success: true, data });
    });
  });

  app.get('/compare/:runId', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const params = request.params as { runId: string };
      const data = await service.getCompareRun(request.user, Number(params.runId));
      reply.status(200).send({ success: true, data });
    });
  });

  app.post('/compare/presets', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const body = parseSchema(saveComparePresetSchema, request.body);
      const data = await service.saveComparePreset(request.user, body);
      reply.status(201).send({ success: true, data });
    });
  });

  app.get('/compare/presets', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const data = await service.listComparePresets(request.user);
      reply.status(200).send({ success: true, data });
    });
  });

  app.post('/compare', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const body = parseSchema(compareRunSchema, request.body);
      const data = await service.runCompare(request.user, body);
      reply.status(200).send({ success: true, data });
    });
  });

  app.get('/trajectory', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const query = parseSchema(trajectoryQuerySchema, request.query);
      const data = await service.getTrajectory(request.user, query);
      reply.status(200).send({ success: true, data });
    });
  });

  app.get('/targets', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const data = await service.listTargets(request.user);
      reply.status(200).send({ success: true, data });
    });
  });

  app.post('/targets/people', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const body = parseSchema(createPersonSchema, request.body);
      const data = await service.createPerson(request.user, body);
      reply.status(201).send({ success: true, data });
    });
  });

  app.post('/targets/assignments', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const body = parseSchema(createTargetAssignmentSchema, request.body);
      const data = await service.createTargetAssignment(request.user, body);
      await service.recomputeTargets(request.user);
      reply.status(201).send({ success: true, data });
    });
  });

  app.get('/targets/:personId', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const params = request.params as { personId: string };
      const data = await service.getTargetsByPerson(request.user, Number(params.personId));
      reply.status(200).send({ success: true, data });
    });
  });

  app.post('/targets/recompute', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      await service.recomputeTargets(request.user);
      reply.status(200).send({ success: true });
    });
  });

  app.post('/targets', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const body = parseSchema(legacyCreateTargetSchema, request.body);
      const target = await service.createLegacyTarget(request.user, body);
      reply.status(201).send({ success: true, data: { target } });
    });
  });

  app.patch('/targets/:id', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const params = request.params as { id: string };
      const body = parseSchema(legacyUpdateTargetSchema, request.body);
      const target = await service.updateLegacyTarget(request.user, Number(params.id), body);
      reply.status(200).send({ success: true, data: { target } });
    });
  });

  app.delete('/targets/:id', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const params = request.params as { id: string };
      await service.deleteLegacyTarget(request.user, Number(params.id));
      reply.status(200).send({ success: true, message: 'Deleted' });
    });
  });
}
