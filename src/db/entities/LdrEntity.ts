import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { randomUUID } from 'crypto';
import { ESupeEntityType } from './supeTypes';

@Entity('ldr_entities')
@Index(['workspaceId', 'entityType', 'entityKey'], { unique: true })
@Index(['workspaceId', 'entityType'])
export class LdrEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string = randomUUID();

  @Column({ name: 'workspace_id', type: 'varchar', length: 36 })
  workspaceId: string;

  @Column({ name: 'entity_type', type: 'enum', enum: ESupeEntityType })
  entityType: ESupeEntityType;

  @Column({ name: 'entity_key', type: 'varchar', length: 160 })
  entityKey: string;

  @Column({ name: 'display_name', type: 'varchar', length: 255 })
  displayName: string;

  @Column({ name: 'geo_zone', type: 'varchar', length: 120, nullable: true })
  geoZone?: string | null;

  @Column({ name: 'geo_region', type: 'varchar', length: 120, nullable: true })
  geoRegion?: string | null;

  @Column({ name: 'geo_area', type: 'varchar', length: 120, nullable: true })
  geoArea?: string | null;

  @Column({ name: 'attrs_json', type: 'jsonb', default: {} })
  attrsJson: Record<string, unknown>;

  @Column({ name: 'first_seen_at', type: 'timestamptz', nullable: true })
  firstSeenAt?: Date | null;

  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
