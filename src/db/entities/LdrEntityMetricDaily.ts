import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { randomUUID } from 'crypto';
import { ESupeEntityType } from './supeTypes';

@Entity('ldr_entity_metric_daily')
@Index(['workspaceId', 'metricDate'])
@Index(['workspaceId', 'entityType', 'entityId', 'metricDate', 'metricKey'], { unique: true })
export class LdrEntityMetricDaily {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string = randomUUID();

  @Column({ name: 'workspace_id', type: 'varchar', length: 36 })
  workspaceId: string;

  @Column({ name: 'entity_type', type: 'enum', enum: ESupeEntityType })
  entityType: ESupeEntityType;

  @Column({ name: 'entity_id', type: 'varchar', length: 36 })
  entityId: string;

  @Column({ name: 'metric_date', type: 'date' })
  metricDate: string;

  @Column({ name: 'metric_key', type: 'varchar', length: 120 })
  metricKey: string;

  @Column({ name: 'metric_value', type: 'numeric', precision: 18, scale: 4, default: 0 })
  metricValue: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
