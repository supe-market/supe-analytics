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
import { ETargetStatus } from './supeTypes';

@Entity('ldr_targets')
@Index(['workspaceId', 'metric'])
@Index(['workspaceId', 'periodLabel'])
@Index(['workspaceId', 'scopeLevel', 'scopeValue'])
export class LdrTarget {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string = randomUUID();

  @Column({ name: 'workspace_id', type: 'varchar', length: 36 })
  workspaceId: string;

  @Column({ name: 'salesman_id', type: 'varchar', length: 36, nullable: true })
  salesmanId?: string | null;

  @Column({ name: 'metric', type: 'varchar', length: 80 })
  metric: string;

  @Column({ name: 'scope_level', type: 'varchar', length: 40, default: 'national' })
  scopeLevel: string;

  @Column({ name: 'scope_value', type: 'varchar', length: 120, default: 'all_india' })
  scopeValue: string;

  @Column({ name: 'target_value', type: 'numeric', precision: 18, scale: 4 })
  targetValue: string;

  @Column({ name: 'actual_value', type: 'numeric', precision: 18, scale: 4, default: 0 })
  actualValue: string;

  @Column({ name: 'period', type: 'varchar', length: 40, nullable: true })
  period?: string | null;

  @Column({ name: 'period_label', type: 'varchar', length: 80 })
  periodLabel: string;

  @Column({ name: 'start_date', type: 'date' })
  startDate: string;

  @Column({ name: 'end_date', type: 'date' })
  endDate: string;

  @Column({ name: 'notes', type: 'text', nullable: true })
  notes?: string | null;

  @Column({ name: 'status', type: 'enum', enum: ETargetStatus, default: ETargetStatus.ACTIVE })
  status: ETargetStatus;

  @Column({ name: 'created_by', type: 'varchar', length: 120, nullable: true })
  createdBy?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date | null;
}
