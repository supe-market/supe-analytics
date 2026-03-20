import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { randomUUID } from 'crypto';

@Entity('ldr_workspaces')
export class LdrWorkspace {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string = randomUUID();

  @Column({ name: 'name', type: 'varchar', length: 120 })
  @Index()
  name: string;

  @Column({ name: 'status', type: 'varchar', length: 20, default: 'active' })
  status: string;

  @Column({ name: 'created_by', type: 'varchar', length: 120, nullable: true })
  createdBy?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
