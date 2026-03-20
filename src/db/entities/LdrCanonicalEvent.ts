import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { randomUUID } from 'crypto';

@Entity('ldr_canonical_events')
@Index(['workspaceId', 'eventDate'])
@Index(['workspaceId', 'eventKey'], { unique: true })
export class LdrCanonicalEvent {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string = randomUUID();

  @Column({ name: 'workspace_id', type: 'varchar', length: 36 })
  workspaceId: string;

  @Column({ name: 'event_key', type: 'varchar', length: 300 })
  eventKey: string;

  @Column({ name: 'event_date', type: 'date' })
  eventDate: string;

  @Column({ name: 'salesman_entity_id', type: 'varchar', length: 36, nullable: true })
  salesmanEntityId?: string | null;

  @Column({ name: 'retailer_entity_id', type: 'varchar', length: 36, nullable: true })
  retailerEntityId?: string | null;

  @Column({ name: 'beat_entity_id', type: 'varchar', length: 36, nullable: true })
  beatEntityId?: string | null;

  @Column({ name: 'distributor_entity_id', type: 'varchar', length: 36, nullable: true })
  distributorEntityId?: string | null;

  @Column({ name: 'sku_entity_id', type: 'varchar', length: 36, nullable: true })
  skuEntityId?: string | null;

  @Column({ name: 'invoice_id', type: 'varchar', length: 120, nullable: true })
  invoiceId?: string | null;

  @Column({ name: 'bill_no', type: 'varchar', length: 120, nullable: true })
  billNo?: string | null;

  @Column({ name: 'measures_json', type: 'jsonb', default: {} })
  measuresJson: Record<string, number>;

  @Column({ name: 'attrs_json', type: 'jsonb', default: {} })
  attrsJson: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
