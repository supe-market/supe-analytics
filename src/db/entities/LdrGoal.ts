import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn
} from 'typeorm';
import { randomUUID } from 'crypto';
import { EGoalStatus } from './supeTypes';

@Entity('ldr_goals')
@Index(['workspaceId', 'status'])
@Index(['workspaceId', 'metricKey'])
export class LdrGoal {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string = randomUUID();

  @Column({ name: 'workspace_id', type: 'varchar', length: 36 })
  workspaceId: string;

  @Column({ name: 'name', type: 'varchar', length: 160 })
  name: string;

  @Column({ name: 'metric_key', type: 'varchar', length: 80 })
  metricKey: string;

  @Column({ name: 'geo_key', type: 'varchar', length: 120, default: 'all_india' })
  geoKey: string;

  @Column({ name: 'baseline', type: 'numeric', precision: 18, scale: 4, default: 0 })
  baseline: string;

  @Column({ name: 'target', type: 'numeric', precision: 18, scale: 4 })
  target: string;

  @Column({ name: 'current', type: 'numeric', precision: 18, scale: 4, default: 0 })
  current: string;

  @Column({ name: 'status', type: 'enum', enum: EGoalStatus, default: EGoalStatus.ACTIVE })
  status: EGoalStatus;

  @Column({ name: 'start_date', type: 'date' })
  startDate: string;

  @Column({ name: 'end_date', type: 'date' })
  endDate: string;

  @Column({ name: 'created_by', type: 'varchar', length: 120, nullable: true })
  createdBy?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date | null;
}
