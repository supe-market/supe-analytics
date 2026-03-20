import { DataSource, In, IsNull } from 'typeorm';
import { randomUUID } from 'crypto';
import { env } from '../../config/env';
import {
  LdrCanonicalEvent,
  LdrCohort,
  LdrEntity,
  LdrEntityRelation,
  LdrGoal,
  LdrGoalSnapshot,
  LdrTarget,
  LdrWorkspace,
  LdrWorkspaceCompanyMap,
  LdrWorkspaceUser
} from '../../db/entities';
import { ESupeEntityType } from '../../db/entities/supeTypes';

export interface IGeoFilter {
  zone?: string;
  region?: string;
  area?: string;
}

export class SupeRepository {
  constructor(private readonly db: DataSource) {}

  async resolveWorkspaceId(input: {
    workspaceId?: string;
    companyId?: string;
    userId?: string;
  }): Promise<string> {
    const workspaceRepo = this.db.getRepository(LdrWorkspace);

    if (input.workspaceId) {
      const found = await workspaceRepo.findOne({ where: { id: input.workspaceId } });
      if (!found) {
        throw new Error('Invalid workspaceId');
      }
      return found.id;
    }

    if (input.companyId) {
      const mapRepo = this.db.getRepository(LdrWorkspaceCompanyMap);
      const mapping = await mapRepo.findOne({ where: { companyId: input.companyId } });
      if (mapping) {
        return mapping.workspaceId;
      }
    }

    if (input.userId) {
      const wsUserRepo = this.db.getRepository(LdrWorkspaceUser);
      const wsUser = await wsUserRepo.findOne({ where: { entityId: input.userId, status: 'active' } });
      if (wsUser) {
        return wsUser.workspaceId;
      }
    }

    if (env.DEFAULT_WORKSPACE_ID) {
      const fallbackWorkspace = await workspaceRepo.findOne({ where: { id: env.DEFAULT_WORKSPACE_ID } });
      if (fallbackWorkspace) {
        return fallbackWorkspace.id;
      }
    }

    const firstWorkspace = await workspaceRepo.findOne({ where: {}, order: { createdAt: 'ASC' } });
    if (firstWorkspace) {
      return firstWorkspace.id;
    }

    const created = workspaceRepo.create({
      id: env.DEFAULT_WORKSPACE_ID || randomUUID(),
      name: env.DEFAULT_WORKSPACE_NAME,
      createdBy: input.userId || 'system'
    });
    await workspaceRepo.save(created);
    return created.id;
  }

  async listEntitiesByType(workspaceId: string, entityType: ESupeEntityType, geo?: IGeoFilter): Promise<LdrEntity[]> {
    const where: any = { workspaceId, entityType };

    if (geo?.zone) {
      where.geoZone = geo.zone;
    }
    if (geo?.region) {
      where.geoRegion = geo.region;
    }
    if (geo?.area) {
      where.geoArea = geo.area;
    }

    return this.db.getRepository(LdrEntity).find({ where, order: { displayName: 'ASC' } });
  }

  async listEntitiesByIds(workspaceId: string, entityType: ESupeEntityType, ids: string[]): Promise<LdrEntity[]> {
    if (!ids.length) {
      return [];
    }

    return this.db
      .getRepository(LdrEntity)
      .find({ where: { workspaceId, entityType, id: In(ids) }, order: { displayName: 'ASC' } });
  }

  async listCanonicalEvents(workspaceId: string, fromDate: string, toDate: string): Promise<LdrCanonicalEvent[]> {
    return this.db
      .getRepository(LdrCanonicalEvent)
      .createQueryBuilder('event')
      .where('event.workspace_id = :workspaceId', { workspaceId })
      .andWhere('event.event_date BETWEEN :fromDate AND :toDate', { fromDate, toDate })
      .orderBy('event.event_date', 'ASC')
      .getMany();
  }

  async listEntityRelations(workspaceId: string): Promise<LdrEntityRelation[]> {
    return this.db.getRepository(LdrEntityRelation).find({ where: { workspaceId } });
  }

  async listGoals(workspaceId: string): Promise<LdrGoal[]> {
    return this.db.getRepository(LdrGoal).find({
      where: {
        workspaceId,
        deletedAt: IsNull()
      },
      order: { createdAt: 'DESC' }
    });
  }

  async listGoalSnapshots(workspaceId: string, goalIds: string[]): Promise<LdrGoalSnapshot[]> {
    if (!goalIds.length) {
      return [];
    }

    return this.db.getRepository(LdrGoalSnapshot).find({
      where: {
        workspaceId,
        goalId: In(goalIds),
        deletedAt: IsNull()
      },
      order: { snapshotDate: 'ASC', weekNumber: 'ASC' }
    });
  }

  async createGoal(payload: Partial<LdrGoal>): Promise<LdrGoal> {
    const repo = this.db.getRepository(LdrGoal);
    const created = repo.create(payload);
    return repo.save(created);
  }

  async getGoalById(workspaceId: string, id: string): Promise<LdrGoal | null> {
    return this.db.getRepository(LdrGoal).findOne({ where: { id, workspaceId, deletedAt: IsNull() } });
  }

  async saveGoal(goal: LdrGoal): Promise<LdrGoal> {
    return this.db.getRepository(LdrGoal).save(goal);
  }

  async createGoalSnapshot(payload: Partial<LdrGoalSnapshot>): Promise<LdrGoalSnapshot> {
    const repo = this.db.getRepository(LdrGoalSnapshot);
    const row = repo.create(payload);
    return repo.save(row);
  }

  async listTargets(workspaceId: string): Promise<LdrTarget[]> {
    return this.db.getRepository(LdrTarget).find({
      where: {
        workspaceId,
        deletedAt: IsNull()
      },
      order: { createdAt: 'DESC' }
    });
  }

  async createTarget(payload: Partial<LdrTarget>): Promise<LdrTarget> {
    const repo = this.db.getRepository(LdrTarget);
    const created = repo.create(payload);
    return repo.save(created);
  }

  async getTargetById(workspaceId: string, targetId: string): Promise<LdrTarget | null> {
    return this.db.getRepository(LdrTarget).findOne({ where: { id: targetId, workspaceId, deletedAt: IsNull() } });
  }

  async saveTarget(target: LdrTarget): Promise<LdrTarget> {
    return this.db.getRepository(LdrTarget).save(target);
  }

  async softDeleteTarget(target: LdrTarget): Promise<LdrTarget> {
    target.deletedAt = new Date();
    return this.db.getRepository(LdrTarget).save(target);
  }

  async getCohortById(workspaceId: string, id: string): Promise<LdrCohort | null> {
    return this.db.getRepository(LdrCohort).findOne({ where: { workspaceId, id } });
  }
}
