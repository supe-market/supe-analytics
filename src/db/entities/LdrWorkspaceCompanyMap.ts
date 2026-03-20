import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { randomUUID } from 'crypto';

@Entity('ldr_workspace_company_map')
@Index(['workspaceId', 'companyId'], { unique: true })
@Index(['companyId'])
export class LdrWorkspaceCompanyMap {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string = randomUUID();

  @Column({ name: 'workspace_id', type: 'varchar', length: 36 })
  workspaceId: string;

  @Column({ name: 'company_id', type: 'varchar', length: 36 })
  companyId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
