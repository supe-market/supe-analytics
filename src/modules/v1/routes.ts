/**
 * Main versioned analytics route registration.
 *
 * This module maps validated HTTP payloads onto `SupeV1Service` operations and
 * keeps endpoint-level error formatting consistent.
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import * as XLSX from 'xlsx';
import { ORDERS_BOOK_HEADERS, SupeV1Service } from './service';
import {
  actionEventSchema,
  actionsListQuerySchema,
  compareRunSchema,
  createActionSchema,
  createPersonSchema,
  createTaskSchema,
  createTargetAssignmentSchema,
  importsListQuerySchema,
  observeDetailQuerySchema,
  legacyCreateTargetSchema,
  legacyUpdateTargetSchema,
  observeEntityTypeSchema,
  observeListQuerySchema,
  saveComparePresetSchema,
  signalDefaultsSchema,
  signalOverridesSchema,
  trajectoryQuerySchema,
  updateActionSchema,
  updateTaskSchema
} from './schemas';

function parseSchema<T>(schema: z.ZodSchema<T>, payload: unknown): T {
  /** Parse request data with Zod and normalize validation failures. */
  try {
    return schema.parse(payload);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(error.issues[0]?.message || 'Validation failed');
    }
    throw error;
  }
}

async function routeWrap(reply: FastifyReply, callback: () => Promise<void>): Promise<void> {
  /** Convert service errors into the API's standard failure response shape. */
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
  /** Register the v1 product APIs on an authenticated Fastify instance. */
  const service = new SupeV1Service(app.db);

  app.post('/imports', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const multipartFile = await (request as any).file();
      if (!multipartFile) {
        throw new Error('file is required');
      }
      const result = await service.createImport(request.user, multipartFile);
      reply.status(201).send({ success: true, data: result });
    });
  });

  app.get('/imports', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const query = parseSchema(importsListQuerySchema, request.query);
      const result = await service.listImports(request.user, query.limit);
      reply.status(200).send({ success: true, data: result });
    });
  });

  app.get('/imports/template', { preHandler: app.authenticate }, async (_request, reply) => {
    await routeWrap(reply, async () => {
      // Generate the template on-the-fly from the canonical header list so it
      // can never drift from what the importer accepts.
      const worksheet = XLSX.utils.aoa_to_sheet([[...ORDERS_BOOK_HEADERS]]);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'orders_book');
      const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
      reply
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', 'attachment; filename="orders_book_template.xlsx"')
        .send(buffer);
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
      await service.updateSignalOverrides(request.user, body.overrides, body.replaceSignalDefinitionIds);
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

  app.get('/actions/dashboard', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const data = await service.getActionsDashboard(request.user);
      reply.status(200).send({ success: true, data });
    });
  });

  app.get('/actions', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const query = parseSchema(actionsListQuerySchema, request.query);
      const data = await service.listActions(request.user, query);
      reply.status(200).send({ success: true, data });
    });
  });

  app.get('/actions/:id', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const params = request.params as { id: string };
      const data = await service.getActionById(request.user, Number(params.id));
      reply.status(200).send({ success: true, data });
    });
  });

  app.post('/actions', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const body = parseSchema(createActionSchema, request.body);
      const data = await service.createAction(request.user, body);
      reply.status(201).send({ success: true, data });
    });
  });

  app.patch('/actions/:id', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const params = request.params as { id: string };
      const body = parseSchema(updateActionSchema, request.body);
      const data = await service.updateAction(request.user, Number(params.id), body);
      reply.status(200).send({ success: true, data });
    });
  });

  app.post('/actions/:id/events', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const params = request.params as { id: string };
      const body = parseSchema(actionEventSchema, request.body);
      const data = await service.appendActionEvent(request.user, Number(params.id), body);
      reply.status(201).send({ success: true, data });
    });
  });

  app.get('/action-log', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const data = await service.getActionLog(request.user);
      reply.status(200).send({ success: true, data });
    });
  });

  app.get('/tasks', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const data = await service.listTasks(request.user);
      reply.status(200).send({ success: true, data });
    });
  });

  app.post('/tasks', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const body = parseSchema(createTaskSchema, request.body);
      const data = await service.createTask(request.user, body);
      reply.status(201).send({ success: true, data });
    });
  });

  app.patch('/tasks/:id', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const params = request.params as { id: string };
      const body = parseSchema(updateTaskSchema, request.body);
      const data = await service.updateTask(request.user, Number(params.id), body);
      reply.status(200).send({ success: true, data });
    });
  });

  app.delete('/tasks/:id', { preHandler: app.authenticate }, async (request, reply) => {
    await routeWrap(reply, async () => {
      const params = request.params as { id: string };
      await service.deleteTask(request.user, Number(params.id));
      reply.status(200).send({ success: true });
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
