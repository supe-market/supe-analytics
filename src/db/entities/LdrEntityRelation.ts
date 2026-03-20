import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { randomUUID } from 'crypto';

@Entity('ldr_entity_relations')
@Index(['workspaceId', 'parentEntityId', 'childEntityId', 'relationType'], { unique: true })
@Index(['workspaceId', 'relationType'])
export class LdrEntityRelation {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string = randomUUID();

  @Column({ name: 'workspace_id', type: 'varchar', length: 36 })
  workspaceId: string;

  @Column({ name: 'parent_entity_id', type: 'varchar', length: 36 })
  parentEntityId: string;

  @Column({ name: 'child_entity_id', type: 'varchar', length: 36 })
  childEntityId: string;

  @Column({ name: 'relation_type', type: 'varchar', length: 80 })
  relationType: string;

  @Column({ name: 'valid_from', type: 'date', nullable: true })
  validFrom?: string | null;

  @Column({ name: 'valid_to', type: 'date', nullable: true })
  validTo?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
