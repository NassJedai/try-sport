import { Inject, Injectable } from '@nestjs/common';
import { getRequestId } from '@try/logger';
import { schema } from '@try/database';
import type { Database, Executor } from '@try/database';
import { DATABASE } from '../../common/database.module.js';

export interface AuditEntry {
  actorId: string | null;
  actorType: 'USER' | 'BUSINESS_MEMBER' | 'ADMIN' | 'SYSTEM';
  action: string;
  entityType: string;
  entityId: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}

/**
 * Audit logging.
 *
 * Callers pass the transaction so the audit row commits atomically with the
 * change it describes. An approval that exists without its audit entry — or an
 * audit entry for a change that rolled back — is worse than no log at all.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async record(executor: Executor, entry: AuditEntry): Promise<void> {
    await executor.insert(schema.auditLogs).values({
      actorId: entry.actorId,
      actorType: entry.actorType,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      metadata: entry.metadata ?? {},
      ipAddress: entry.ipAddress ?? null,
      requestId: getRequestId() ?? null,
    });
  }

  /** For actions with no surrounding transaction (read-only admin views). */
  async recordStandalone(entry: AuditEntry): Promise<void> {
    await this.record(this.db, entry);
  }
}
