import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { randomUUID } from 'crypto';
import { ESupeEntityType } from './supeTypes';

@Entity('ldr_cohorts')
@Index(['workspaceId', 'entityType'])
export class LdrCohort {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string = randomUUID();

  @Column({ name: 'workspace_id', type: 'varchar', length: 36 })
  workspaceId: string;

  @Column({ name: 'name', type: 'varchar', length: 140 })
  name: string;

  @Column({ name: 'entity_type', type: 'enum', enum: ESupeEntityType })
  entityType: ESupeEntityType;

  @Column({ name: 'entity_ids', type: 'jsonb' })
  entityIds: string[];

  @Column({ name: 'source_json', type: 'jsonb', default: {} })
  sourceJson: Record<string, unknown>;

  @Column({ name: 'created_by', type: 'varchar', length: 120, nullable: true })
  createdBy?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
