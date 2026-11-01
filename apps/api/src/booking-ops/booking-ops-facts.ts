import type { Prisma } from '@prisma/client'
import type { BookingOpsFacts, BookingOpsJobFacts, BookingStatus } from '@bedbanks/contracts'
import type { BookingSupplierResolver } from './supplier/booking-supplier.port'

type Tx = Prisma.TransactionClient
/** The booking columns the queue reads. The caller selects exactly these plus the ops state. */
export const OPS_BOOKING_SELECT = {
  id: true, reference: true, status: true, supplierStatus: true, supplier: true, supplierRef: true, createdAt: true, checkIn: true, closedAt: true, agencyId: true, hotelId: true, updatedAt: true, opsState: true,
} satisfies Prisma.BookingSelect
export type OpsBookingRow = Prisma.BookingGetPayload<{ select: typeof OPS_BOOKING_SELECT }>

/** Lifecycle-log actions that are operational activity: a case with one of these in the last week is "recent" even after it left the queue. */
export const OPS_ACTIVITY_ACTIONS = ['opsAssigned', 'opsUnassigned', 'opsAcknowledged', 'opsEscalated', 'opsDeescalated', 'opsResolved', 'opsNote', 'opsAnswer', 'supplierQueued', 'supplierUnknown', 'supplierNotFound', 'supplierCancelFailed']
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

/**
 * Loads, for a set of bookings, every fact the queue ruleset needs, in a fixed number of queries (never one per booking). Reads only; runs on the booking role.
 * `supplierConfigured` asks the resolver, so a mock name for the wrong tenant is "not configured" here exactly as it is when sending.
 */
export async function loadOpsFacts(tx: Tx, tenantId: string, rows: OpsBookingRow[], resolver: BookingSupplierResolver): Promise<Map<string, BookingOpsFacts>> {
  const ids = rows.map((r) => r.id)
  const out = new Map<string, BookingOpsFacts>()
  if (ids.length === 0) return out
  const [jobs, failed, lastCalls, events] = await Promise.all([
    tx.bookingSupplierJob.findMany({ where: { tenantId, bookingId: { in: ids } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { bookingId: true, kind: true, status: true, attempt: true, maxAttempts: true, lastErrorCode: true, updatedAt: true } }),
    tx.bookingSupplierCall.groupBy({ by: ['bookingId'], where: { tenantId, bookingId: { in: ids }, outcome: { in: ['TIMEOUT', 'ERROR'] } }, _count: { _all: true } }),
    tx.bookingSupplierCall.groupBy({ by: ['bookingId'], where: { tenantId, bookingId: { in: ids } }, _max: { createdAt: true } }),
    tx.bookingEvent.findMany({
      where: { tenantId, bookingId: { in: ids }, OR: [{ action: { in: ['supplierUnknown', 'supplierCancelFailed'] } }, { toStatus: { in: ['ON_REQUEST', 'CANCEL_REQUESTED', 'AMEND_REQUESTED', 'CONFIRMED'] } }] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { bookingId: true, fromStatus: true, toStatus: true, action: true, createdAt: true },
    }),
  ])
  const latestJob = new Map<string, BookingOpsJobFacts & { active: boolean }>()
  for (const j of jobs) if (!latestJob.has(j.bookingId)) latestJob.set(j.bookingId, { kind: j.kind, status: j.status, attempt: j.attempt, maxAttempts: j.maxAttempts, lastErrorCode: j.lastErrorCode, updatedAt: j.updatedAt.toISOString(), active: ['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(j.status) })
  const active = new Set(jobs.filter((j) => ['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(j.status)).map((j) => j.bookingId))
  const failedBy = new Map(failed.map((f) => [f.bookingId, f._count._all]))
  const lastBy = new Map(lastCalls.map((c) => [c.bookingId, iso(c._max.createdAt)]))
  const entered = new Map<string, Partial<Record<BookingStatus, string>>>(); const unknownAt = new Map<string, string>(); const cancelFailedAt = new Map<string, string>()
  for (const e of events) {
    if (e.action === 'supplierUnknown' && !unknownAt.has(e.bookingId)) unknownAt.set(e.bookingId, e.createdAt.toISOString())
    if (e.action === 'supplierCancelFailed' && !cancelFailedAt.has(e.bookingId)) cancelFailedAt.set(e.bookingId, e.createdAt.toISOString())
    if (e.fromStatus !== e.toStatus) { const m = entered.get(e.bookingId) ?? {}; m[e.toStatus as BookingStatus] ??= e.createdAt.toISOString(); entered.set(e.bookingId, m) } // events are newest first: the first seen is the latest entry
  }
  for (const r of rows) {
    const job = latestJob.get(r.id) ?? null; const o = r.opsState
    out.set(r.id, {
      status: r.status as BookingStatus, closed: r.closedAt !== null, supplierStatus: r.supplierStatus, supplierConfigured: resolver.resolve(tenantId, r.supplier) !== null, supplierRef: r.supplierRef, createdAt: r.createdAt.toISOString(),
      checkIn: r.checkIn ? r.checkIn.toISOString().slice(0, 10) : null,
      latestJob: job ? { kind: job.kind, status: job.status, attempt: job.attempt, maxAttempts: job.maxAttempts, lastErrorCode: job.lastErrorCode, updatedAt: job.updatedAt } : null,
      hasActiveJob: active.has(r.id), failedCalls: failedBy.get(r.id) ?? 0, lastSupplierActivityAt: lastBy.get(r.id) ?? null, enteredStatusAt: entered.get(r.id) ?? {},
      supplierUnknownAt: unknownAt.get(r.id) ?? null, cancelFailedAt: cancelFailedAt.get(r.id) ?? null,
      ops: o ? { version: o.version, assigneeUserId: o.assigneeUserId, assignedAt: iso(o.assignedAt), acknowledgedAt: iso(o.acknowledgedAt), manualPriority: o.manualPriority, escalatedAt: iso(o.escalatedAt), followUp: o.followUp, followUpAt: iso(o.followUpAt), resolvedAt: iso(o.resolvedAt) } : null,
    })
  }
  return out
}
