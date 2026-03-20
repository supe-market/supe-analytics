import { Column, CreateDateColumn, DeleteDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { randomUUID } from 'crypto';

@Entity('ldr_goal_snapshots')
@Index(['workspaceId', 'goalId', 'weekNumber'], { unique: true })
@Index(['workspaceId', 'goalId', 'snapshotDate'])
export class LdrGoalSnapshot {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string = randomUUID();

  @Column({ name: 'workspace_id', type: 'varchar', length: 36 })
  workspaceId: string;

  @Column({ name: 'goal_id', type: 'varchar', length: 36 })
  goalId: string;

  @Column({ name: 'week_number', type: 'int' })
  weekNumber: number;

  @Column({ name: 'required_value', type: 'numeric', precision: 18, scale: 4, default: 0 })
  requiredValue: string;

  @Column({ name: 'actual_value', type: 'numeric', precision: 18, scale: 4, default: 0 })
  actualValue: string;

  @Column({ name: 'snapshot_date', type: 'date' })
  snapshotDate: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt?: Date | null;
}
