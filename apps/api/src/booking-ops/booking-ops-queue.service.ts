import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  answersFor, BOOKING_OPS_PAGE_SIZES, BOOKING_OPS_PRIORITIES, BOOKING_OPS_REASON_LABEL, BOOKING_OPS_REASONS, BOOKING_OPS_SCAN_CAP, BOOKING_OPS_SLA_STATES, BOOKING_OPS_TABS, bookingOpsTabIncludes, BOOKING_STATUSES,
  compareBookingOps, evaluateBookingOps, parseBookingOpsSlaPolicy, type BookingAccessView, type BookingOperationsPanel, type BookingOpsCounts, type BookingOpsEvaluation, type BookingOpsFacts,
  type BookingOpsPriority, type BookingOpsQueueItem, type BookingOpsQueuePage, type BookingOpsReason, type BookingOpsSlaPolicy, type BookingOpsSlaState, type BookingOpsTab, type BookingOpsTimelineItem, type BookingStatus,
} from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { BookingOpsDatabase } from './booking-ops-database'
import { loadOpsFacts, OPS_ACTIVITY_ACTIONS, OPS_BOOKING_SELECT, type OpsBookingRow } from './booking-ops-facts'
import { BOOKING_SUPPLIER_RESOLVER, type BookingSupplierResolver } from './supplier/booking-supplier.port'

export const bookingOpsEnabled = (env: Record<string, string | undefined> = process.env) => env.ADMIN_BOOKING_OPS_ENABLED === 'true'
const RECENT_DAYS = 7
const DAY = /^\d{4}-\d{2}-\d{2}$/
const REF = /^[A-Za-z0-9._:-]{3,64}$/
const ID = /^[A-Za-z0-9_-]{1,64}$/
const bad = (message: string) => new BadRequestException({ message, code: 'VALIDATION_ERROR' })
const csv = (v: unknown): string[] => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : [])
function many<T extends string>(v: unknown, allowed: readonly T[], label: string): T[] | undefined {
  if (v === undefined || v === '') return undefined
  const out = csv(v); for (const x of out) if (!(allowed as readonly string[]).includes(x)) throw bad(`${label} has an unknown value`)
  return out as T[]
}
function day(v: unknown, label: string): string | undefined {
  if (v === undefined || v === '') return undefined
  if (typeof v !== 'string' || !DAY.test(v) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) throw bad(`${label} must be a real date as YYYY-MM-DD`)
  return v
}

export interface ParsedQueueQuery {
  tab: BookingOpsTab; reference?: string; agencyId?: string; supplier?: string; status?: BookingStatus[]; supplierStatus?: string; reason?: BookingOpsReason[]; priority?: BookingOpsPriority[]
  assignee?: string; sla?: BookingOpsSlaState[]; checkInFrom?: string; checkInTo?: string; createdFrom?: string; createdTo?: string; page: number; pageSize: number
}
/** Strict, like the booking list: a bad value is a 400, never a silently broader queue. Sorting is not a parameter: the order is the queue's. */
export function parseQueueQuery(raw: Record<string, unknown>): ParsedQueueQuery {
  const tab = raw.tab === undefined || raw.tab === '' ? 'active' : (BOOKING_OPS_TABS as readonly string[]).includes(String(raw.tab)) ? (raw.tab as BookingOpsTab) : (() => { throw bad('tab is not recognised') })()
  const str = (k: string, re: RegExp, label: string) => { const v = raw[k]; if (v === undefined || v === '') return undefined; if (typeof v !== 'string' || !re.test(v)) throw bad(`${label} is not valid`); return v }
  const pageSize = raw.pageSize === undefined ? 25 : Number(raw.pageSize); const page = raw.page === undefined ? 1 : Number(raw.page)
  if (!(BOOKING_OPS_PAGE_SIZES as readonly number[]).includes(pageSize)) throw bad('pageSize must be 25, 50 or 100')
  if (!Number.isInteger(page) || page < 1 || page > 10_000) throw bad('page must be a positive whole number')
  const assignee = str('assignee', /^(me|none|[A-Za-z0-9_-]{1,64})$/, 'assignee')
  return {
    tab, reference: str('reference', REF, 'reference'), agencyId: str('agencyId', ID, 'agencyId'), supplier: str('supplier', /^.{1,80}$/, 'supplier'), status: many(raw.status, BOOKING_STATUSES, 'status'),
    supplierStatus: str('supplierStatus', /^[A-Z_]{2,40}$/, 'supplierStatus'), reason: many(raw.reason, BOOKING_OPS_REASONS, 'reason'), priority: many(raw.priority, BOOKING_OPS_PRIORITIES, 'priority'), assignee,
    sla: many(raw.sla, BOOKING_OPS_SLA_STATES, 'sla'), checkInFrom: day(raw.checkInFrom, 'checkInFrom'), checkInTo: day(raw.checkInTo, 'checkInTo'), createdFrom: day(raw.createdFrom, 'createdFrom'), createdTo: day(raw.createdTo, 'createdTo'), page, pageSize,
  }
}

/** Who may see the queue, and the SLA policy in force. Fails closed: switched off, no permission, or an invalid policy is an error, never an empty queue. */
export function requireOpsView(access: BookingAccessView): void {
  if (!bookingOpsEnabled()) throw new ForbiddenException({ message: 'The operations queue is switched off in this environment', code: 'BOOKING_OPS_DISABLED' })
  if (access.level !== 'OPERATOR' || !access.permissions.includes('booking.ops.view')) throw new ForbiddenException({ message: 'You do not have permission to use the operations queue', code: 'BOOKING_OPS_FORBIDDEN' })
}
export function slaPolicy(env: Record<string, string | undefined> = process.env): BookingOpsSlaPolicy {
  const parsed = parseBookingOpsSlaPolicy(env.BOOKING_OPS_SLA_POLICY)
  if (!parsed.ok) throw new ServiceUnavailableException({ message: `The SLA policy is invalid: ${parsed.error}. Fix BOOKING_OPS_SLA_POLICY; the queue will not guess.`, code: 'BOOKING_OPS_SLA_POLICY_INVALID' })
  return parsed.policy
}

interface Evaluated { row: OpsBookingRow; facts: BookingOpsFacts; evaluation: BookingOpsEvaluation; lastActivityAt: string | null }

@Injectable()
export class BookingOpsQueueService {
  constructor(private readonly db: BookingOpsDatabase, private readonly prisma: PrismaService, @Inject(BOOKING_SUPPLIER_RESOLVER) private readonly suppliers: BookingSupplierResolver) {}

  /** Bookings that could be in the queue: open and in a state that needs a person, or carrying a manual follow-up. Newest activity first, capped. */
  private async candidates(tenantId: string, now: Date, policy: BookingOpsSlaPolicy) {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx.booking.findMany({
        where: { tenantId, closedAt: null, OR: [{ status: { in: ['PENDING_SUPPLIER', 'ON_REQUEST', 'CANCEL_REQUESTED', 'AMEND_REQUESTED'] } }, { status: 'CONFIRMED', supplierRef: null }, { opsState: { is: { resolvedAt: null, OR: [{ followUp: true }, { manualPriority: { not: null } }] } } }] },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: BOOKING_OPS_SCAN_CAP + 1, select: OPS_BOOKING_SELECT,
      })
      const capped = rows.length > BOOKING_OPS_SCAN_CAP; const page = capped ? rows.slice(0, BOOKING_OPS_SCAN_CAP) : rows
      const facts = await loadOpsFacts(tx, tenantId, page, this.suppliers)
      const evaluated: Evaluated[] = page.map((row) => ({ row, facts: facts.get(row.id)!, evaluation: evaluateBookingOps(facts.get(row.id)!, now, policy), lastActivityAt: null })).filter((e) => e.evaluation.inQueue)
      // Recently resolved: operational activity in the last week on a booking that is no longer a case.
      const since = new Date(now.getTime() - RECENT_DAYS * 86_400_000)
      const recent = await tx.bookingEvent.groupBy({ by: ['bookingId'], where: { tenantId, action: { in: OPS_ACTIVITY_ACTIONS }, createdAt: { gte: since } }, _max: { createdAt: true }, orderBy: { _max: { createdAt: 'desc' } }, take: 500 })
      const activeIds = new Set(evaluated.map((e) => e.row.id))
      const resolvedIds = recent.filter((r) => !activeIds.has(r.bookingId))
      const resolvedRows = resolvedIds.length ? await tx.booking.findMany({ where: { tenantId, id: { in: resolvedIds.map((r) => r.bookingId) } }, select: OPS_BOOKING_SELECT }) : []
      const resolvedFacts = await loadOpsFacts(tx, tenantId, resolvedRows, this.suppliers)
      const lastBy = new Map(resolvedIds.map((r) => [r.bookingId, r._max.createdAt?.toISOString() ?? null]))
      const resolved: Evaluated[] = resolvedRows.map((row) => ({ row, facts: resolvedFacts.get(row.id)!, evaluation: evaluateBookingOps(resolvedFacts.get(row.id)!, now, policy), lastActivityAt: lastBy.get(row.id) ?? null })).filter((e) => !e.evaluation.inQueue)
      resolved.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') || (a.row.id < b.row.id ? -1 : 1))
      return { active: evaluated, resolved, capped }
    })
  }

  async list(tenantId: string, userId: string, access: BookingAccessView, rawQuery: Record<string, unknown>, now = new Date()): Promise<BookingOpsQueuePage> {
    requireOpsView(access)
    const policy = slaPolicy(); const q = parseQueueQuery(rawQuery)
    const { active, resolved, capped } = await this.candidates(tenantId, now, policy)
    const counts = {} as BookingOpsCounts
    for (const tab of BOOKING_OPS_TABS) counts[tab] = tab === 'resolved' ? resolved.length : active.filter((e) => bookingOpsTabIncludes(tab, e.evaluation, userId)).length
    const pool = q.tab === 'resolved' ? resolved : active.filter((e) => bookingOpsTabIncludes(q.tab as Exclude<BookingOpsTab, 'resolved'>, e.evaluation, userId))
    const filtered = pool.filter((e) => this.matches(e, q, userId))
    if (q.tab !== 'resolved') filtered.sort((a, b) => compareBookingOps({ evaluation: a.evaluation, bookingId: a.row.id }, { evaluation: b.evaluation, bookingId: b.row.id }))
    const start = (q.page - 1) * q.pageSize
    const slice = filtered.slice(start, start + q.pageSize)
    const names = await this.names(tenantId, slice.map((e) => e.row))
    return { items: slice.map((e) => this.toItem(e, names)), total: filtered.length, page: q.page, pageSize: q.pageSize, tab: q.tab, counts, scanCapped: capped, slaPolicy: policy, generatedAt: now.toISOString() }
  }

  private matches(e: Evaluated, q: ParsedQueueQuery, me: string): boolean {
    const r = e.row; const ev = e.evaluation
    if (q.reference && !r.reference.toUpperCase().startsWith(q.reference.toUpperCase())) return false
    if (q.agencyId && (q.agencyId === 'unassigned' ? r.agencyId !== null : r.agencyId !== q.agencyId)) return false
    if (q.supplier && !r.supplier.toLowerCase().includes(q.supplier.toLowerCase())) return false
    if (q.status && !q.status.includes(r.status as BookingStatus)) return false
    if (q.supplierStatus && (r.supplierStatus ?? '') !== q.supplierStatus) return false
    if (q.reason && !q.reason.some((x) => ev.reasons.includes(x))) return false
    if (q.priority && !q.priority.includes(ev.priority)) return false
    if (q.sla && (!ev.slaState || !q.sla.includes(ev.slaState))) return false
    if (q.assignee) { const who = q.assignee === 'me' ? me : q.assignee; if (q.assignee === 'none' ? ev.assigneeUserId !== null : ev.assigneeUserId !== who) return false }
    const checkIn = r.checkIn ? r.checkIn.toISOString().slice(0, 10) : null
    if (q.checkInFrom && (!checkIn || checkIn < q.checkInFrom)) return false
    if (q.checkInTo && (!checkIn || checkIn > q.checkInTo)) return false
    const created = r.createdAt.toISOString().slice(0, 10)
    if (q.createdFrom && created < q.createdFrom) return false
    if (q.createdTo && created > q.createdTo) return false
    return true
  }

  /** Names come from the API's own role, tenant-scoped: hotels, agencies and the staff who own cases. Never anyone outside this tenant. */
  async names(tenantId: string, rows: Array<Pick<OpsBookingRow, 'hotelId' | 'agencyId' | 'opsState'>>) {
    const hotelIds = [...new Set(rows.map((r) => r.hotelId))]; const agencyIds = [...new Set(rows.map((r) => r.agencyId).filter((x): x is string => !!x))]
    const userIds = [...new Set(rows.map((r) => r.opsState?.assigneeUserId).filter((x): x is string => !!x))]
    const read = await this.prisma.withTenant(tenantId, async (t) => ({
      hotels: hotelIds.length ? await t.hotel.findMany({ where: { tenantId, id: { in: hotelIds } }, select: { id: true, name: true, city: true, timeZone: true } }) : [],
      agencies: agencyIds.length ? await t.agency.findMany({ where: { tenantId, id: { in: agencyIds } }, select: { id: true, name: true } }) : [],
      users: userIds.length ? await t.user.findMany({ where: { id: { in: userIds }, memberships: { some: { tenantId } } }, select: { id: true, name: true, email: true } }) : [],
    })).catch(() => ({ hotels: [], agencies: [], users: [] }))
    return { hotels: new Map(read.hotels.map((h) => [h.id, h])), agencies: new Map(read.agencies.map((a) => [a.id, a.name])), users: new Map(read.users.map((u) => [u.id, u.name || u.email])) }
  }

  toItem(e: Evaluated, names: Awaited<ReturnType<BookingOpsQueueService['names']>>): BookingOpsQueueItem {
    const r = e.row; const ev = e.evaluation; const hotel = names.hotels.get(r.hotelId)
    return {
      bookingId: r.id, reference: r.reference, agency: r.agencyId ? { id: r.agencyId, name: names.agencies.get(r.agencyId) ?? 'Agency' } : null, hotel: { name: hotel?.name ?? null, city: hotel?.city ?? null, timeZone: hotel?.timeZone ?? null },
      checkIn: r.checkIn ? r.checkIn.toISOString().slice(0, 10) : null, status: r.status as BookingStatus, supplierStatus: r.supplierStatus, supplier: { name: r.supplier, configured: e.facts.supplierConfigured },
      inQueue: ev.inQueue, primaryReason: ev.primaryReason, reasons: ev.reasons, priority: ev.priority, priorityFactors: ev.priorityFactors, slaTargetMinutes: ev.slaTargetMinutes, slaDueAt: ev.slaDueAt, slaState: ev.slaState, slaRemainingSeconds: ev.slaRemainingSeconds,
      enteredAt: ev.enteredAt, assignee: ev.assigneeUserId ? { id: ev.assigneeUserId, name: names.users.get(ev.assigneeUserId) ?? 'Former user' } : null, assignedAt: ev.assignedAt, acknowledgedAt: ev.acknowledgedAt,
      lastSupplierActivityAt: e.facts.lastSupplierActivityAt, supplierCertainty: ev.supplierCertainty, safeAction: ev.safeAction, opsVersion: e.facts.ops?.version ?? 0, lastActivityAt: e.lastActivityAt,
    }
  }

  /** One booking's evaluation, on the caller's own transaction. Used by the detail read and by the mutations, so they judge it identically. */
  async evaluateOne(tx: Prisma.TransactionClient, tenantId: string, bookingId: string, now: Date, policy: BookingOpsSlaPolicy): Promise<Evaluated | null> {
    const row = await tx.booking.findFirst({ where: { id: bookingId, tenantId }, select: OPS_BOOKING_SELECT })
    if (!row) return null
    const facts = (await loadOpsFacts(tx, tenantId, [row], this.suppliers)).get(row.id)!
    return { row, facts, evaluation: evaluateBookingOps(facts, now, policy), lastActivityAt: null }
  }

  /** The operations panel of the booking detail page. Null when the queue is off or the caller lacks `booking.ops.view`; never an error on the detail page. */
  async panel(tenantId: string, access: BookingAccessView, bookingId: string, now = new Date()): Promise<BookingOperationsPanel | null> {
    if (!bookingOpsEnabled() || access.level !== 'OPERATOR' || !access.permissions.includes('booking.ops.view')) return null
    const policy = slaPolicy()
    const loaded = await this.db.withTenant(tenantId, async (tx) => {
      const e = await this.evaluateOne(tx, tenantId, bookingId, now, policy)
      if (!e) return null
      const events = await tx.bookingEvent.findMany({ where: { tenantId, bookingId, action: { in: OPS_ACTIVITY_ACTIONS } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20, select: { createdAt: true, action: true, reason: true, actorId: true, actorType: true, payload: true } })
      return { e, events }
    })
    if (!loaded) throw new NotFoundException({ message: 'Booking not found', code: 'BOOKING_NOT_FOUND' })
    const { e, events } = loaded
    const actorIds = [...new Set(events.map((x) => x.actorId).filter((x): x is string => !!x))]
    const names = await this.names(tenantId, [e.row])
    const actors = actorIds.length ? new Map((await this.prisma.withTenant(tenantId, (t) => t.user.findMany({ where: { id: { in: actorIds }, memberships: { some: { tenantId } } }, select: { id: true, name: true, email: true } })).catch(() => [])).map((u) => [u.id, u.name || u.email])) : new Map<string, string>()
    const ev = e.evaluation; const held = new Set(access.permissions)
    const timeline: BookingOpsTimelineItem[] = events.slice().reverse().map((x) => ({ at: x.createdAt.toISOString(), kind: 'event' as const, title: OPS_EVENT_TITLE[x.action ?? ''] ?? (x.action ?? 'Event'), actorName: x.actorId ? actors.get(x.actorId) ?? null : x.actorType === 'SUPPLIER' ? 'Supplier' : null, reason: x.reason }))
    if (ev.inQueue && ev.enteredAt) timeline.push({ at: ev.enteredAt, kind: 'derived', title: `Entered the operations queue: ${BOOKING_OPS_REASON_LABEL[ev.primaryReason!]}`, actorName: null, reason: null })
    if (ev.inQueue && ev.slaDueAt) timeline.push({ at: ev.slaDueAt, kind: 'derived', title: ev.slaState === 'BREACHED' ? 'SLA breached' : 'SLA due', actorName: null, reason: null })
    timeline.sort((a, b) => a.at.localeCompare(b.at))
    const state = e.facts.ops
    return {
      item: this.toItem(e, names),
      can: {
        assign: ev.inQueue && held.has('booking.ops.assign'), acknowledge: ev.inQueue && held.has('booking.ops.assign') && ev.assigneeUserId !== null, escalate: held.has('booking.ops.escalate') && !e.facts.closed,
        note: held.has('booking.ops.note'), clearFollowUp: held.has('booking.ops.resolve') && !!state && (state.followUp || state.manualPriority !== null) && !state.resolvedAt,
        answers: held.has('booking.ops.resolve') ? answersFor(e.facts.status, e.facts.closed) : [],
      },
      timeline,
    }
  }
}

const OPS_EVENT_TITLE: Record<string, string> = {
  opsAssigned: 'Assigned', opsUnassigned: 'Unassigned', opsAcknowledged: 'Acknowledged', opsEscalated: 'Escalated', opsDeescalated: 'Escalation cleared', opsResolved: 'Operations case resolved', opsNote: 'Operations note',
  opsAnswer: 'Supplier answer recorded by an operator', supplierQueued: 'Supplier sync or send requested', supplierUnknown: 'Supplier answer still unknown', supplierNotFound: 'Supplier holds no booking under our reference', supplierCancelFailed: 'Cancellation refused by the supplier',
}
