import { BadRequestException, Injectable, UnprocessableEntityException } from '@nestjs/common'
import {
  COMPLIANCE_CATEGORY_VALUES, COMPLIANCE_REPORT_MAX_DAYS, COMPLIANCE_REPORT_MAX_RECORDS, COMPLIANCE_REPORT_TOO_LARGE, SUMMARY_WINDOW_DEFAULT_DAYS, SUMMARY_WINDOW_MAX_DAYS,
  type ComplianceCategoryValue, type ComplianceReport, type ComplianceReportFormat, type ComplianceExportState, type ComplianceRecordPage, type ComplianceRecordView, type ComplianceSummary,
} from '@bedbanks/contracts'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../database/prisma.service'
import { buildComplianceReport } from './compliance-report'
import { day, guardedRead, iso, sectionRead } from './operations-read'
import { boolParam, dayParam, endOfDay, enumParam, intParam, likeLiteral, paged, pageParams, textParam } from './query-params'

const DAY_MS = 86_400_000
const EXPORT_STATES: readonly ComplianceExportState[] = ['PENDING', 'SEALED', 'STORED']

/** The columns the API role may read (runtime-role-contract COMPLIANCE_RECORD_READ_COLUMNS). Never the payload. Every query names them. */
const RECORD_SELECT = {
  id: true, category: true, action: true, entityType: true, entityId: true, actorType: true, userId: true, occurredAt: true, payloadSha256: true,
  originCountry: true, destinationCountry: true, crossBorder: true,
  exports: { select: { batch: { select: { sequence: true, storageStatus: true, storedAt: true } } } },
} as const satisfies Prisma.ComplianceRecordSelect

const toView = (r: Prisma.ComplianceRecordGetPayload<{ select: typeof RECORD_SELECT }>): ComplianceRecordView => ({
  id: r.id, occurredAt: r.occurredAt.toISOString(), category: r.category, action: r.action, entityType: r.entityType, entityId: r.entityId, actorType: r.actorType,
  userId: r.userId, payloadSha256: r.payloadSha256, originCountry: r.originCountry, destinationCountry: r.destinationCountry, crossBorder: r.crossBorder,
  exportState: r.exports ? r.exports.batch.storageStatus : 'PENDING', batchSequence: r.exports?.batch.sequence ?? null, storedAt: iso(r.exports?.batch.storedAt),
})

/**
 * Compliance evidence for the active tenant (ADR 0067 amendment 1): what the capture trigger recorded and how far each record is on its way to
 * WORM storage. Read-only. Row-level security limits every read to the tenant's own records; platform (tenantless) records are never shown here.
 */
@Injectable()
export class OperationsComplianceService {
  /** Overridable in tests; never injected. */
  clock: () => Date = () => new Date()

  constructor(private readonly prisma: PrismaService) {}

  async summary(tenantId: string, query: Record<string, unknown>): Promise<ComplianceSummary> {
    const days = intParam('days', query.days, 1, SUMMARY_WINDOW_MAX_DAYS) ?? SUMMARY_WINDOW_DEFAULT_DAYS
    const now = this.clock()
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    const start = new Date(today.getTime() - (days - 1) * DAY_MS)
    const occurredAt = { gte: start, lte: endOfDay(today) }
    const counts = await guardedRead(() => this.prisma.withTenant(tenantId, async (tx) => {
      const [byCategory, jurisdiction] = await Promise.all([
        tx.complianceRecord.groupBy({ by: ['category'], where: { tenantId, occurredAt }, _count: { _all: true } }),
        tx.complianceRecord.groupBy({ by: ['crossBorder'], where: { tenantId, occurredAt, category: 'BOOKING_JURISDICTION' }, _count: { _all: true } }),
      ])
      return { byCategory, jurisdiction }
    }))
    const exportState = await sectionRead(() => this.prisma.withTenant(tenantId, async (tx) => {
      const [batches, stored, head, lastStored, pending] = await Promise.all([
        tx.complianceExportBatch.count({ where: { scopeKey: tenantId } }),
        tx.complianceExportBatch.count({ where: { scopeKey: tenantId, storageStatus: 'STORED' } }),
        tx.complianceExportBatch.findFirst({ where: { scopeKey: tenantId }, orderBy: { sequence: 'desc' }, select: { sequence: true, batchSha256: true } }),
        tx.complianceExportBatch.findFirst({ where: { scopeKey: tenantId, storageStatus: 'STORED' }, orderBy: { sequence: 'desc' }, select: { storedAt: true } }),
        tx.complianceRecord.aggregate({ where: { tenantId, exports: { is: null } }, _count: { _all: true }, _min: { occurredAt: true } }),
      ])
      return {
        batches, stored, sealedNotStored: batches - stored, headSequence: head?.sequence ?? null, headSha256: head?.batchSha256 ?? null,
        lastStoredAt: iso(lastStored?.storedAt), pendingRecords: pending._count._all, oldestPendingAt: iso(pending._min.occurredAt),
      }
    }))
    const count = (value: boolean | null) => counts.jurisdiction.find((j) => j.crossBorder === value)?._count._all ?? 0
    return {
      generatedAt: now.toISOString(), window: { from: day(start), to: day(today), days },
      definitions: {
        byCategory: 'Audit events the database captured as compliance evidence in the window, by category. Capture happens in the same transaction as the audit event, so no mutation is missing from here.',
        bookings: 'Booking confirmations, cancellations and manual bookings in the window. Cross-border: the agency\'s country differs from the hotel\'s. Unknown: either country is not recorded; it is never guessed.',
        export: 'Hash-chained batches of this tenant\'s records in write-once storage. Pending records are not yet in a batch; a sealed batch is waiting to be stored. All-time, not limited to the window.',
      },
      byCategory: COMPLIANCE_CATEGORY_VALUES.map((category) => ({ category, count: counts.byCategory.find((c) => c.category === category)?._count._all ?? 0 })),
      bookings: { crossBorder: count(true), domestic: count(false), unknown: count(null) },
      export: exportState,
    }
  }

  async records(tenantId: string, query: Record<string, unknown>): Promise<ComplianceRecordPage> {
    const page = pageParams(query)
    const category = enumParam<ComplianceCategoryValue>('category', query.category, COMPLIANCE_CATEGORY_VALUES)
    const exportState = enumParam('exportState', query.exportState, EXPORT_STATES)
    const crossBorder = boolParam('crossBorder', query.crossBorder)
    const action = textParam('action', query.action)
    const from = dayParam('from', query.from)
    const to = dayParam('to', query.to)
    if (from && to && from > to) throw new BadRequestException('Invalid date range')
    const where: Prisma.ComplianceRecordWhereInput = {
      tenantId,
      ...(category ? { category } : {}),
      ...(crossBorder !== undefined ? { crossBorder } : {}),
      ...(action ? { action: { contains: likeLiteral(action), mode: 'insensitive' } } : {}),
      ...(from || to ? { occurredAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: endOfDay(to) } : {}) } } : {}),
      ...(exportState === 'PENDING' ? { exports: { is: null } } : exportState ? { exports: { is: { batch: { storageStatus: exportState } } } } : {}),
    }
    return guardedRead(() => this.prisma.withTenant(tenantId, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.complianceRecord.findMany({ where, select: RECORD_SELECT, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], skip: page.skip, take: page.take }),
        tx.complianceRecord.count({ where }),
      ])
      return paged(rows.map(toView), page, total)
    }))
  }

  /**
   * The per-period report (ADR 0067 amendment 3): every record of the period, oldest first, with counts, export coverage and an attestation.
   * The read and the `compliance.report.exported` audit event share one transaction, so the event (itself captured as DATA_EXPORT evidence) names
   * exactly the hash of what was handed out. A period over the record cap is refused, never truncated.
   */
  async report(tenantId: string, userId: string, requestId: string, query: Record<string, unknown>): Promise<{ report: ComplianceReport; format: ComplianceReportFormat }> {
    const from = dayParam('from', query.from)
    const to = dayParam('to', query.to)
    if (!from || !to) throw new BadRequestException('from and to are required (YYYY-MM-DD)')
    if (from > to || (to.getTime() - from.getTime()) / DAY_MS + 1 > COMPLIANCE_REPORT_MAX_DAYS) throw new BadRequestException(`Invalid period: from must not be after to, and the period is at most ${COMPLIANCE_REPORT_MAX_DAYS} days`)
    const format = enumParam<ComplianceReportFormat>('format', query.format, ['json', 'csv']) ?? 'json'
    const generatedAt = this.clock()
    const report = await guardedRead(() => this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.complianceRecord.findMany({
        where: { tenantId, occurredAt: { gte: from, lte: endOfDay(to) } }, select: RECORD_SELECT, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }], take: COMPLIANCE_REPORT_MAX_RECORDS + 1,
      })
      if (rows.length > COMPLIANCE_REPORT_MAX_RECORDS) {
        throw new UnprocessableEntityException({ code: COMPLIANCE_REPORT_TOO_LARGE, message: `The period holds more than ${COMPLIANCE_REPORT_MAX_RECORDS} compliance records. Choose a shorter period.` })
      }
      const head = await tx.complianceExportBatch.findFirst({ where: { scopeKey: tenantId }, orderBy: { sequence: 'desc' }, select: { sequence: true, batchSha256: true, storageStatus: true, storedAt: true } })
      const built = buildComplianceReport({
        tenantId, from: day(from), to: day(to), generatedAt, generatedByUserId: userId, records: rows.map(toView),
        chainHead: head ? { sequence: head.sequence, batchSha256: head.batchSha256, storageStatus: head.storageStatus, storedAt: iso(head.storedAt) } : null,
      })
      await tx.auditEvent.create({ data: {
        tenantId, userId, actorType: 'USER', action: 'compliance.report.exported', entityType: 'compliance_report', entityId: `${built.period.from}..${built.period.to}`,
        payload: { requestId, format, records: built.attestation.recordCount, recordsSha256: built.attestation.recordsSha256, chainHeadSequence: head?.sequence ?? null },
      } })
      return built
    }))
    return { report, format }
  }
}
