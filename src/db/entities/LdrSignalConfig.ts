import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { randomUUID } from 'crypto';
import { ESignalScopeType } from './supeTypes';

@Entity('ldr_signal_configs')
@Index(['workspaceId', 'pattern', 'scopeType', 'scopeValue'], { unique: true })
export class LdrSignalConfig {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string = randomUUID();

  @Column({ name: 'workspace_id', type: 'varchar', length: 36 })
  workspaceId: string;

  @Column({ name: 'pattern', type: 'varchar', length: 80 })
  pattern: string;

  @Column({ name: 'scope_type', type: 'enum', enum: ESignalScopeType, default: ESignalScopeType.NATIONAL })
  scopeType: ESignalScopeType;

  @Column({ name: 'scope_value', type: 'varchar', length: 120, nullable: true })
  scopeValue?: string | null;

  @Column({ name: 'operator', type: 'varchar', length: 8, default: 'lt' })
  operator: string;

  @Column({ name: 'threshold_value', type: 'numeric', precision: 14, scale: 4 })
  thresholdValue: string;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'description', type: 'varchar', length: 255, nullable: true })
  description?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
