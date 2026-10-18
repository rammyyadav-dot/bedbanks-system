import { Injectable } from '@nestjs/common'
import type { LedgerIntegrityView } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { LedgerAuditDatabase } from '../ledger/ledger-audit-database'
import { buildLedgerIntegrityReport } from '../ledger/ledger-integrity-report'
import { guardedRead } from './operations-read'

/**
 * Live ledger integrity report (ADR 0063). Read-only. On a deployment with the restricted ledger-audit credential it reads through that
 * (the strict API role has no ledger access); otherwise through the ordinary client, which answers the typed 503 when the ledger is not readable.
 */
@Injectable()
export class OperationsLedgerIntegrityService {
  constructor(private readonly prisma: PrismaService, private readonly audit: LedgerAuditDatabase) {}

  report(tenantId: string, now = new Date()): Promise<LedgerIntegrityView> {
    const work = (tx: Parameters<typeof buildLedgerIntegrityReport>[0]) => buildLedgerIntegrityReport(tx, tenantId, now)
    return this.audit.configured() ? this.audit.withTenant(tenantId, work) : guardedRead(() => this.prisma.withTenant(tenantId, work))
  }
}
