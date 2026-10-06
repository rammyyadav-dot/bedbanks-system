/**
 * The Admin booking operations queue (ADR 0039, Phase 4): the one authoritative ruleset for "does this booking need a person, why, how urgent, and by when".
 * Pure data and pure functions, shared by the API (which evaluates every list, count and detail with it) and the Admin (which only labels the result). No SQL,
 * controller or component carries its own copy of these rules.
 *
 * Lifecycle status and operational priority are separate: nothing here changes a booking's status. The queue is DERIVED from facts the module already
 * records (booking status, supplier answer, supplier jobs, the lifecycle log). Only true operational state is stored (assignment, acknowledgement, a manual
 * escalation floor, a manual follow-up flag): see `BookingOpsStateView`. SLA state and "overdue by 37 minutes" are computed from a due timestamp at read time;
 * nothing is mutated to turn a row red.
 *
 * UNKNOWN is not FAILED. A supplier timeout alone never authorises another booking request.
 */
import type { BookingStatus } from './operations'

// ---- vocabulary ---------------------------------------------------------------------------------------------------------
/** In order of precedence: the first that applies is the primary reason; every one that applies is listed. */
export const BOOKING_OPS_REASONS = ['SUPPLIER_UNKNOWN', 'CANCELLATION_FAILED', 'CANCEL_REQUESTED', 'SUPPLIER_JOB_EXHAUSTED', 'SUPPLIER_NOT_CONFIGURED', 'PENDING_SUPPLIER', 'ON_REQUEST', 'AMEND_REQUESTED', 'MISSING_SUPPLIER_REF', 'MANUAL_FOLLOW_UP'] as const
export type BookingOpsReason = (typeof BOOKING_OPS_REASONS)[number]
export const BOOKING_OPS_REASON_LABEL: Record<BookingOpsReason, string> = {
  SUPPLIER_UNKNOWN: 'Supplier answer unknown', CANCELLATION_FAILED: 'Cancellation not confirmed by supplier', CANCEL_REQUESTED: 'Cancel requested', SUPPLIER_JOB_EXHAUSTED: 'Supplier attempts exhausted',
  SUPPLIER_NOT_CONFIGURED: 'Supplier not configured', PENDING_SUPPLIER: 'Pending supplier', ON_REQUEST: 'On request', AMEND_REQUESTED: 'Amendment requested', MISSING_SUPPLIER_REF: 'Missing supplier reference', MANUAL_FOLLOW_UP: 'Manual follow-up',
}

export const BOOKING_OPS_PRIORITIES = ['NORMAL', 'HIGH', 'URGENT', 'CRITICAL'] as const
export type BookingOpsPriority = (typeof BOOKING_OPS_PRIORITIES)[number]
export const BOOKING_OPS_PRIORITY_LABEL: Record<BookingOpsPriority, string> = { NORMAL: 'Normal', HIGH: 'High', URGENT: 'Urgent', CRITICAL: 'Critical' }
/** Operators may raise a case to these (never lower the derived priority). */
export const BOOKING_OPS_MANUAL_PRIORITIES = ['HIGH', 'URGENT', 'CRITICAL'] as const satisfies readonly BookingOpsPriority[]

export const BOOKING_OPS_SLA_STATES = ['WITHIN_SLA', 'DUE_SOON', 'BREACHED'] as const
export type BookingOpsSlaState = (typeof BOOKING_OPS_SLA_STATES)[number]
export const BOOKING_OPS_SLA_LABEL: Record<BookingOpsSlaState, string> = { WITHIN_SLA: 'Within SLA', DUE_SOON: 'Due soon', BREACHED: 'SLA breached' }

/** CERTAIN: the supplier's answer is known. UNCERTAIN: it is not (unknown, or a call timed out and is still being settled): never treat it as failed, never resend blindly. */
export type BookingSupplierCertainty = 'CERTAIN' | 'UNCERTAIN'

/** The one next step that is safe to take now. Never "send" while the answer is uncertain. */
export const BOOKING_OPS_SAFE_ACTIONS = ['SYNC_WITH_SUPPLIER', 'RECORD_SUPPLIER_ANSWER', 'SETTLE_CANCELLATION', 'SEND_TO_SUPPLIER', 'SEND_CANCELLATION', 'RETRY_NOW', 'WAIT_FOR_SUPPLIER', 'ADD_SUPPLIER_REFERENCE', 'REVIEW_AMENDMENT', 'FOLLOW_UP'] as const
export type BookingOpsSafeAction = (typeof BOOKING_OPS_SAFE_ACTIONS)[number]
export const BOOKING_OPS_SAFE_ACTION_LABEL: Record<BookingOpsSafeAction, string> = {
  SYNC_WITH_SUPPLIER: 'Sync with supplier', RECORD_SUPPLIER_ANSWER: 'Record the supplier’s answer', SETTLE_CANCELLATION: 'Settle the cancellation with the supplier', SEND_TO_SUPPLIER: 'Send to supplier',
  SEND_CANCELLATION: 'Send cancellation to supplier', RETRY_NOW: 'Retry now', WAIT_FOR_SUPPLIER: 'Waiting for the supplier', ADD_SUPPLIER_REFERENCE: 'Add the supplier reference', REVIEW_AMENDMENT: 'Review the amendment', FOLLOW_UP: 'Follow up',
}

// ---- SLA policy ---------------------------------------------------------------------------------------------------------
export interface BookingOpsSlaPolicy {
  /** Minutes from entering the queue for this reason until the SLA is due. */
  minutes: Record<BookingOpsReason, number>
  /** A case is DUE_SOON when the time left is at most this fraction of its target (but never less than `dueSoonMinMinutes`). */
  dueSoonFraction: number
  dueSoonMinMinutes: number
}
/** Sensible defaults; a deployment overrides them with `BOOKING_OPS_SLA_POLICY` (JSON of the same shape, partial allowed), validated strictly, never silently ignored. */
export const DEFAULT_BOOKING_OPS_SLA_POLICY: BookingOpsSlaPolicy = {
  minutes: {
    SUPPLIER_UNKNOWN: 15, CANCELLATION_FAILED: 15, CANCEL_REQUESTED: 60, SUPPLIER_JOB_EXHAUSTED: 30, SUPPLIER_NOT_CONFIGURED: 60, PENDING_SUPPLIER: 30, ON_REQUEST: 24 * 60, AMEND_REQUESTED: 4 * 60, MISSING_SUPPLIER_REF: 4 * 60, MANUAL_FOLLOW_UP: 8 * 60,
  },
  dueSoonFraction: 0.25, dueSoonMinMinutes: 5,
}
export type SlaPolicyParse = { ok: true; policy: BookingOpsSlaPolicy } | { ok: false; error: string }
/** Parses the override. Unknown keys, non-integers, zero or negative minutes, or absurd values are an error: a typo must not quietly change an SLA. */
export function parseBookingOpsSlaPolicy(raw: string | undefined | null): SlaPolicyParse {
  if (raw === undefined || raw === null || raw.trim() === '') return { ok: true, policy: DEFAULT_BOOKING_OPS_SLA_POLICY }
  let value: unknown
  try { value = JSON.parse(raw) } catch { return { ok: false, error: 'BOOKING_OPS_SLA_POLICY is not valid JSON' } }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, error: 'BOOKING_OPS_SLA_POLICY must be a JSON object' }
  const obj = value as Record<string, unknown>
  const policy: BookingOpsSlaPolicy = { minutes: { ...DEFAULT_BOOKING_OPS_SLA_POLICY.minutes }, dueSoonFraction: DEFAULT_BOOKING_OPS_SLA_POLICY.dueSoonFraction, dueSoonMinMinutes: DEFAULT_BOOKING_OPS_SLA_POLICY.dueSoonMinMinutes }
  for (const key of Object.keys(obj)) {
    if (key === 'minutes') {
      const m = obj.minutes
      if (typeof m !== 'object' || m === null || Array.isArray(m)) return { ok: false, error: 'minutes must be an object' }
      for (const [reason, minutes] of Object.entries(m as Record<string, unknown>)) {
        if (!(BOOKING_OPS_REASONS as readonly string[]).includes(reason)) return { ok: false, error: `unknown queue reason "${reason}"` }
        if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 60 * 24 * 30) return { ok: false, error: `minutes.${reason} must be a whole number from 1 to 43200` }
        policy.minutes[reason as BookingOpsReason] = minutes
      }
    } else if (key === 'dueSoonFraction') {
      if (typeof obj.dueSoonFraction !== 'number' || !(obj.dueSoonFraction > 0 && obj.dueSoonFraction < 1)) return { ok: false, error: 'dueSoonFraction must be above 0 and below 1' }
      policy.dueSoonFraction = obj.dueSoonFraction
    } else if (key === 'dueSoonMinMinutes') {
      if (typeof obj.dueSoonMinMinutes !== 'number' || !Number.isInteger(obj.dueSoonMinMinutes) || obj.dueSoonMinMinutes < 0 || obj.dueSoonMinMinutes > 1440) return { ok: false, error: 'dueSoonMinMinutes must be a whole number from 0 to 1440' }
      policy.dueSoonMinMinutes = obj.dueSoonMinMinutes
    } else return { ok: false, error: `unknown key "${key}"` }
  }
  return { ok: true, policy }
}

// ---- facts in, evaluation out ------------------------------------------------------------------------------------------
export interface BookingOpsJobFacts { kind: 'BOOK' | 'CANCEL' | 'STATUS_CHECK'; status: 'QUEUED' | 'RUNNING' | 'RETRY_WAIT' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'; attempt: number; maxAttempts: number; lastErrorCode: string | null; updatedAt: string }
/** The durable operational state: the only part of the queue that is stored. */
export interface BookingOpsStateFacts {
  version: number
  assigneeUserId: string | null; assignedAt: string | null
  acknowledgedAt: string | null
  manualPriority: BookingOpsPriority | null; escalatedAt: string | null
  followUp: boolean; followUpAt: string | null
  resolvedAt: string | null
}
export interface BookingOpsFacts {
  status: BookingStatus
  closed: boolean
  supplierStatus: string | null
  supplierConfigured: boolean
  supplierRef: string | null
  createdAt: string
  /** `YYYY-MM-DD`. */
  checkIn: string | null
  latestJob: BookingOpsJobFacts | null
  hasActiveJob: boolean
  /** Calls that timed out or errored, over the life of the booking. */
  failedCalls: number
  lastSupplierActivityAt: string | null
  /** When the booking last entered each status (from the lifecycle log), and when the supplier last became unknown / refused a cancellation. */
  enteredStatusAt: Partial<Record<BookingStatus, string>>
  supplierUnknownAt: string | null
  cancelFailedAt: string | null
  ops: BookingOpsStateFacts | null
}

export interface BookingOpsEvaluation {
  inQueue: boolean
  reasons: BookingOpsReason[]
  primaryReason: BookingOpsReason | null
  enteredAt: string | null
  slaTargetMinutes: number | null
  slaDueAt: string | null
  slaState: BookingOpsSlaState | null
  /** Seconds until due; negative when overdue. Derived at read time, never stored. */
  slaRemainingSeconds: number | null
  priority: BookingOpsPriority
  /** Why the priority is what it is, so the screen can say so. */
  priorityFactors: string[]
  supplierCertainty: BookingSupplierCertainty
  safeAction: BookingOpsSafeAction | null
  /** The assignee, unless the assignment pre-dates the current case (then the case is new and unassigned). */
  assigneeUserId: string | null
  assignedAt: string | null
  acknowledgedAt: string | null
}

const PENDING_LIKE: readonly BookingStatus[] = ['PENDING_SUPPLIER', 'ON_REQUEST', 'CANCEL_REQUESTED']
const BASE_PRIORITY: Record<BookingOpsReason, BookingOpsPriority> = {
  SUPPLIER_UNKNOWN: 'URGENT', CANCELLATION_FAILED: 'URGENT', CANCEL_REQUESTED: 'HIGH', SUPPLIER_JOB_EXHAUSTED: 'HIGH', SUPPLIER_NOT_CONFIGURED: 'HIGH',
  PENDING_SUPPLIER: 'NORMAL', ON_REQUEST: 'NORMAL', AMEND_REQUESTED: 'NORMAL', MISSING_SUPPLIER_REF: 'NORMAL', MANUAL_FOLLOW_UP: 'NORMAL',
}
const rank = (p: BookingOpsPriority) => BOOKING_OPS_PRIORITIES.indexOf(p)
const raise = (p: BookingOpsPriority, by: number): BookingOpsPriority => BOOKING_OPS_PRIORITIES[Math.min(BOOKING_OPS_PRIORITIES.length - 1, rank(p) + by)]
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN)

/** Which of the reasons apply to these facts. Pure. */
export function bookingOpsReasons(f: BookingOpsFacts): BookingOpsReason[] {
  if (f.closed) return []
  const job = f.latestJob
  const out = new Set<BookingOpsReason>()
  const pendingLike = PENDING_LIKE.includes(f.status)
  if (pendingLike && (f.supplierStatus === 'UNKNOWN' || job?.status === 'UNKNOWN')) out.add('SUPPLIER_UNKNOWN')
  if (f.status === 'CANCEL_REQUESTED' && (f.supplierStatus === 'CANCEL_FAILED' || (job?.kind === 'CANCEL' && job.status === 'FAILED'))) out.add('CANCELLATION_FAILED')
  if (f.status === 'CANCEL_REQUESTED') out.add('CANCEL_REQUESTED')
  if (pendingLike && job?.status === 'FAILED') {
    if (job.lastErrorCode === 'SUPPLIER_NOT_CONFIGURED') out.add('SUPPLIER_NOT_CONFIGURED')
    else if (job.attempt >= job.maxAttempts && !out.has('CANCELLATION_FAILED') && job.lastErrorCode !== 'ALREADY_APPLIED' && job.lastErrorCode !== 'BOOKING_NOT_FOUND') out.add('SUPPLIER_JOB_EXHAUSTED')
  }
  if (f.status === 'PENDING_SUPPLIER') out.add('PENDING_SUPPLIER')
  if (f.status === 'ON_REQUEST') out.add('ON_REQUEST')
  if (f.status === 'AMEND_REQUESTED') out.add('AMEND_REQUESTED')
  if (f.status === 'CONFIRMED' && !f.supplierRef) out.add('MISSING_SUPPLIER_REF')
  const o = f.ops
  if (o && (o.followUp || o.manualPriority) && !o.resolvedAt) out.add('MANUAL_FOLLOW_UP')
  return BOOKING_OPS_REASONS.filter((r) => out.has(r))
}

function enteredAtFor(reason: BookingOpsReason, f: BookingOpsFacts): string | null {
  switch (reason) {
    case 'SUPPLIER_UNKNOWN': return f.supplierUnknownAt ?? f.latestJob?.updatedAt ?? null
    case 'CANCELLATION_FAILED': return f.cancelFailedAt ?? f.latestJob?.updatedAt ?? null
    case 'CANCEL_REQUESTED': return f.enteredStatusAt.CANCEL_REQUESTED ?? f.createdAt
    case 'SUPPLIER_JOB_EXHAUSTED': case 'SUPPLIER_NOT_CONFIGURED': return f.latestJob?.updatedAt ?? null
    case 'PENDING_SUPPLIER': return f.createdAt
    case 'ON_REQUEST': return f.enteredStatusAt.ON_REQUEST ?? f.createdAt
    case 'AMEND_REQUESTED': return f.enteredStatusAt.AMEND_REQUESTED ?? f.createdAt
    case 'MISSING_SUPPLIER_REF': return f.enteredStatusAt.CONFIRMED ?? f.createdAt
    case 'MANUAL_FOLLOW_UP': return f.ops?.followUpAt ?? f.ops?.escalatedAt ?? null
  }
}

function certainty(f: BookingOpsFacts, reasons: BookingOpsReason[]): BookingSupplierCertainty {
  if (reasons.includes('SUPPLIER_UNKNOWN')) return 'UNCERTAIN'
  // A call timed out and the job is still waiting to settle it: a timeout is not an answer.
  if (f.latestJob && (f.latestJob.status === 'RETRY_WAIT' || f.latestJob.status === 'RUNNING') && f.failedCalls > 0) return 'UNCERTAIN'
  return 'CERTAIN'
}

function safeActionFor(f: BookingOpsFacts, primary: BookingOpsReason, c: BookingSupplierCertainty): BookingOpsSafeAction {
  const job = f.latestJob
  const active = f.hasActiveJob
  switch (primary) {
    case 'SUPPLIER_UNKNOWN': return f.supplierConfigured ? 'SYNC_WITH_SUPPLIER' : 'RECORD_SUPPLIER_ANSWER' // never "send": it could create a duplicate
    case 'CANCELLATION_FAILED': return 'SETTLE_CANCELLATION'
    case 'CANCEL_REQUESTED': return active ? (job?.status === 'RETRY_WAIT' ? 'RETRY_NOW' : 'WAIT_FOR_SUPPLIER') : f.supplierConfigured ? 'SEND_CANCELLATION' : 'RECORD_SUPPLIER_ANSWER'
    case 'PENDING_SUPPLIER':
      if (active) return job?.status === 'RETRY_WAIT' ? 'RETRY_NOW' : 'WAIT_FOR_SUPPLIER'
      return f.supplierConfigured && c === 'CERTAIN' && f.supplierStatus !== 'UNKNOWN' ? 'SEND_TO_SUPPLIER' : 'RECORD_SUPPLIER_ANSWER'
    case 'ON_REQUEST': return active ? 'WAIT_FOR_SUPPLIER' : f.supplierConfigured ? 'SYNC_WITH_SUPPLIER' : 'RECORD_SUPPLIER_ANSWER'
    case 'SUPPLIER_JOB_EXHAUSTED': case 'SUPPLIER_NOT_CONFIGURED': return 'RECORD_SUPPLIER_ANSWER'
    case 'MISSING_SUPPLIER_REF': return 'ADD_SUPPLIER_REFERENCE'
    case 'AMEND_REQUESTED': return 'REVIEW_AMENDMENT'
    case 'MANUAL_FOLLOW_UP': return 'FOLLOW_UP'
  }
}

/** The single evaluation of one booking. `now` is injected so SLA state is testable without a clock. */
export function evaluateBookingOps(f: BookingOpsFacts, now: Date, policy: BookingOpsSlaPolicy = DEFAULT_BOOKING_OPS_SLA_POLICY): BookingOpsEvaluation {
  const reasons = bookingOpsReasons(f)
  const primary = reasons[0] ?? null
  const none: BookingOpsEvaluation = { inQueue: false, reasons: [], primaryReason: null, enteredAt: null, slaTargetMinutes: null, slaDueAt: null, slaState: null, slaRemainingSeconds: null, priority: 'NORMAL', priorityFactors: [], supplierCertainty: 'CERTAIN', safeAction: null, assigneeUserId: null, assignedAt: null, acknowledgedAt: null }
  if (!primary) return none
  const c = certainty(f, reasons)
  const enteredAt = enteredAtFor(primary, f)
  const target = policy.minutes[primary]
  const dueMs = Number.isNaN(ms(enteredAt)) ? NaN : ms(enteredAt) + target * 60_000
  let slaState: BookingOpsSlaState | null = null; let remaining: number | null = null; let slaDueAt: string | null = null
  if (!Number.isNaN(dueMs)) {
    slaDueAt = new Date(dueMs).toISOString(); remaining = Math.trunc((dueMs - now.getTime()) / 1000)
    const soonWindow = Math.max(target * policy.dueSoonFraction, policy.dueSoonMinMinutes) * 60
    slaState = remaining < 0 ? 'BREACHED' : remaining <= soonWindow ? 'DUE_SOON' : 'WITHIN_SLA'
  }
  // Priority: the reason's base, raised by facts, never below a manual escalation. Deterministic.
  let priority = BASE_PRIORITY[primary]; const factors: string[] = [`${BOOKING_OPS_REASON_LABEL[primary]}: ${BOOKING_OPS_PRIORITY_LABEL[priority].toLowerCase()} by default`]
  if (slaState === 'BREACHED') { priority = raise(priority, 1); factors.push('SLA breached') }
  const checkInMs = f.checkIn ? Date.parse(`${f.checkIn}T00:00:00Z`) : NaN
  if (!Number.isNaN(checkInMs) && checkInMs - now.getTime() <= 24 * 3_600_000) { priority = raise(priority, 1); factors.push('check-in within 24 hours or already passed') }
  if (f.failedCalls >= 3) { priority = raise(priority, 1); factors.push(`${f.failedCalls} failed supplier calls`) }
  const manual = f.ops && !f.ops.resolvedAt ? f.ops.manualPriority : null
  if (manual && rank(manual) > rank(priority)) { priority = manual; factors.push('escalated by an operator') }
  else if (manual) factors.push('escalated by an operator (already at least that high)')
  // An assignment older than the current case belongs to an earlier case: this one is new and unassigned.
  const o = f.ops
  const fresh = o?.assigneeUserId && (Number.isNaN(ms(enteredAt)) || ms(o.assignedAt) >= ms(enteredAt))
  return {
    inQueue: true, reasons, primaryReason: primary, enteredAt, slaTargetMinutes: target, slaDueAt, slaState, slaRemainingSeconds: remaining, priority, priorityFactors: factors,
    supplierCertainty: c, safeAction: safeActionFor(f, primary, c),
    assigneeUserId: fresh ? o!.assigneeUserId : null, assignedAt: fresh ? o!.assignedAt : null,
    acknowledgedAt: fresh && o!.acknowledgedAt && ms(o!.acknowledgedAt) >= ms(enteredAt) ? o!.acknowledgedAt : null,
  }
}

const SLA_RANK: Record<BookingOpsSlaState, number> = { BREACHED: 0, DUE_SOON: 1, WITHIN_SLA: 2 }
/**
 * The queue order, the same everywhere: priority (Critical first), then SLA state (breached, due soon, within), then the oldest case, then booking id so pages never
 * shuffle. A comparator on evaluations, so a client cannot re-sort a page into a different "authoritative" order.
 */
export function compareBookingOps(a: { evaluation: BookingOpsEvaluation; bookingId: string }, b: { evaluation: BookingOpsEvaluation; bookingId: string }): number {
  const pa = rank(a.evaluation.priority); const pb = rank(b.evaluation.priority)
  if (pa !== pb) return pb - pa
  const sa = a.evaluation.slaState ? SLA_RANK[a.evaluation.slaState] : 3; const sb = b.evaluation.slaState ? SLA_RANK[b.evaluation.slaState] : 3
  if (sa !== sb) return sa - sb
  const ea = ms(a.evaluation.enteredAt); const eb = ms(b.evaluation.enteredAt)
  if (ea !== eb && !(Number.isNaN(ea) && Number.isNaN(eb))) return Number.isNaN(ea) ? 1 : Number.isNaN(eb) ? -1 : ea - eb
  return a.bookingId < b.bookingId ? -1 : a.bookingId > b.bookingId ? 1 : 0
}

// ---- tabs ---------------------------------------------------------------------------------------------------------------
export const BOOKING_OPS_TABS = ['active', 'mine', 'unassigned', 'breached', 'dueSoon', 'unknown', 'cancellation', 'onRequest', 'resolved'] as const
export type BookingOpsTab = (typeof BOOKING_OPS_TABS)[number]
export const BOOKING_OPS_TAB_LABEL: Record<BookingOpsTab, string> = { active: 'Active queue', mine: 'My queue', unassigned: 'Unassigned', breached: 'SLA breached', dueSoon: 'Due soon', unknown: 'Unknown supplier state', cancellation: 'Cancellation issues', onRequest: 'On request', resolved: 'Resolved / recent' }
/** Whether an in-queue evaluation belongs to a tab. `resolved` is not decided here (it is the cases that left the queue). */
export function bookingOpsTabIncludes(tab: Exclude<BookingOpsTab, 'resolved'>, e: BookingOpsEvaluation, me: string | null): boolean {
  if (!e.inQueue) return false
  switch (tab) {
    case 'active': return true
    case 'mine': return me !== null && e.assigneeUserId === me
    case 'unassigned': return e.assigneeUserId === null
    case 'breached': return e.slaState === 'BREACHED'
    case 'dueSoon': return e.slaState === 'DUE_SOON'
    case 'unknown': return e.reasons.includes('SUPPLIER_UNKNOWN')
    case 'cancellation': return e.reasons.includes('CANCELLATION_FAILED') || e.reasons.includes('CANCEL_REQUESTED')
    case 'onRequest': return e.reasons.includes('ON_REQUEST')
  }
}

// ---- the manual supplier answer ------------------------------------------------------------------------------------------
/**
 * What an authorised operator may record when the supplier's answer is uncertain or unobtainable. Each is a named, evidenced fact, never a status picker:
 * `SUPPLIER_HAS_NO_BOOKING` is not `SUPPLIER_REJECTED`. Only the first, with evidence, makes sending again safe.
 */
export const BOOKING_OPS_ANSWERS = ['SUPPLIER_CONFIRMED', 'SUPPLIER_ON_REQUEST', 'SUPPLIER_REJECTED', 'SUPPLIER_HAS_NO_BOOKING', 'SUPPLIER_CANCELLED', 'SUPPLIER_REFUSED_CANCELLATION', 'STILL_AWAITING_SUPPLIER'] as const
export type BookingOpsAnswer = (typeof BOOKING_OPS_ANSWERS)[number]
export const BOOKING_OPS_ANSWER_LABEL: Record<BookingOpsAnswer, string> = {
  SUPPLIER_CONFIRMED: 'Supplier confirmed the booking', SUPPLIER_ON_REQUEST: 'Supplier answered “on request”', SUPPLIER_REJECTED: 'Supplier rejected the booking', SUPPLIER_HAS_NO_BOOKING: 'Supplier confirms no booking exists',
  SUPPLIER_CANCELLED: 'Supplier confirmed the cancellation', SUPPLIER_REFUSED_CANCELLATION: 'Supplier refused the cancellation', STILL_AWAITING_SUPPLIER: 'Still awaiting the supplier',
}
export const BOOKING_OPS_ANSWER_HELP: Record<BookingOpsAnswer, string> = {
  SUPPLIER_CONFIRMED: 'Moves the booking to Confirmed. Needs the supplier’s booking reference.',
  SUPPLIER_ON_REQUEST: 'Moves a Pending booking to On request.',
  SUPPLIER_REJECTED: 'The supplier declined it. Fails a pending booking (or rejects an on-request one). This is not the same as “no booking exists”.',
  SUPPLIER_HAS_NO_BOOKING: 'The supplier states it holds nothing under our reference. The status does not change, the unknown outcome is cleared, and only then is sending again safe. Needs who told you and a reference for the evidence.',
  SUPPLIER_CANCELLED: 'Moves Cancel requested to Cancelled. Needs the supplier’s cancellation reference.',
  SUPPLIER_REFUSED_CANCELLATION: 'Records that the supplier refused. The booking stays Cancel requested and becomes an urgent case.',
  STILL_AWAITING_SUPPLIER: 'Records a note that you asked and are waiting. Nothing else changes.',
}
export interface BookingOpsAnswerRule { answer: BookingOpsAnswer; from: readonly BookingStatus[]; requires: readonly ('reference' | 'evidence')[]; movesStatus: boolean; needsNoActiveJob: boolean }
/** Which answers are valid from which status. Anything else is `BOOKING_OPS_INVALID_TRANSITION`. */
export const BOOKING_OPS_ANSWER_RULES: Readonly<Record<BookingOpsAnswer, BookingOpsAnswerRule>> = {
  SUPPLIER_CONFIRMED: { answer: 'SUPPLIER_CONFIRMED', from: ['PENDING_SUPPLIER', 'ON_REQUEST'], requires: ['reference'], movesStatus: true, needsNoActiveJob: false },
  SUPPLIER_ON_REQUEST: { answer: 'SUPPLIER_ON_REQUEST', from: ['PENDING_SUPPLIER'], requires: [], movesStatus: true, needsNoActiveJob: false },
  SUPPLIER_REJECTED: { answer: 'SUPPLIER_REJECTED', from: ['PENDING_SUPPLIER', 'ON_REQUEST'], requires: [], movesStatus: true, needsNoActiveJob: false },
  SUPPLIER_HAS_NO_BOOKING: { answer: 'SUPPLIER_HAS_NO_BOOKING', from: ['PENDING_SUPPLIER'], requires: ['evidence'], movesStatus: false, needsNoActiveJob: true },
  SUPPLIER_CANCELLED: { answer: 'SUPPLIER_CANCELLED', from: ['CANCEL_REQUESTED'], requires: ['reference'], movesStatus: true, needsNoActiveJob: false },
  SUPPLIER_REFUSED_CANCELLATION: { answer: 'SUPPLIER_REFUSED_CANCELLATION', from: ['CANCEL_REQUESTED'], requires: [], movesStatus: false, needsNoActiveJob: true },
  STILL_AWAITING_SUPPLIER: { answer: 'STILL_AWAITING_SUPPLIER', from: ['PENDING_SUPPLIER', 'ON_REQUEST', 'CANCEL_REQUESTED'], requires: [], movesStatus: false, needsNoActiveJob: false },
}
export function answersFor(status: BookingStatus, closed: boolean): BookingOpsAnswer[] {
  return closed ? [] : BOOKING_OPS_ANSWERS.filter((a) => BOOKING_OPS_ANSWER_RULES[a].from.includes(status))
}

// ---- API: queue list, counts, detail panel, mutations ---------------------------------------------------------------------
export const BOOKING_OPS_PERMISSIONS = { view: 'booking.ops.view', assign: 'booking.ops.assign', escalate: 'booking.ops.escalate', resolve: 'booking.ops.resolve', note: 'booking.ops.note' } as const
export const BOOKING_OPS_PAGE_SIZES = [25, 50, 100] as const
/** The queue is derived from at most this many candidate bookings (newest activity first); beyond it the page says so rather than pretending to be complete. */
export const BOOKING_OPS_SCAN_CAP = 2000
export const BOOKING_OPS_ERROR_CODES = ['BOOKING_OPS_DISABLED', 'BOOKING_OPS_FORBIDDEN', 'BOOKING_OPS_INVALID_TRANSITION', 'BOOKING_OPS_CONFLICT', 'BOOKING_OPS_CROSS_TENANT_DENIED', 'BOOKING_OPS_INELIGIBLE_ASSIGNEE', 'BOOKING_OPS_SLA_POLICY_INVALID', 'SUPPLIER_STATE_UNKNOWN', 'SUPPLIER_NOT_CONFIGURED'] as const

export interface BookingOpsQueueQuery {
  tab?: BookingOpsTab
  reference?: string
  agencyId?: string
  supplier?: string
  status?: BookingStatus[]
  supplierStatus?: string
  reason?: BookingOpsReason[]
  priority?: BookingOpsPriority[]
  /** `me`, `none`, or a user id. */
  assignee?: string
  sla?: BookingOpsSlaState[]
  checkInFrom?: string
  checkInTo?: string
  createdFrom?: string
  createdTo?: string
  page?: number
  pageSize?: (typeof BOOKING_OPS_PAGE_SIZES)[number]
}

export interface BookingOpsQueueItem {
  bookingId: string
  reference: string
  agency: { id: string; name: string } | null
  hotel: { name: string | null; city: string | null; timeZone: string | null }
  checkIn: string | null
  status: BookingStatus
  supplierStatus: string | null
  supplier: { name: string; configured: boolean }
  inQueue: boolean
  primaryReason: BookingOpsReason | null
  reasons: BookingOpsReason[]
  priority: BookingOpsPriority
  priorityFactors: string[]
  slaTargetMinutes: number | null
  slaDueAt: string | null
  slaState: BookingOpsSlaState | null
  /** Seconds to the SLA due time; negative when overdue. Derived when read, never stored. */
  slaRemainingSeconds: number | null
  enteredAt: string | null
  assignee: { id: string; name: string } | null
  assignedAt: string | null
  acknowledgedAt: string | null
  lastSupplierActivityAt: string | null
  supplierCertainty: BookingSupplierCertainty
  safeAction: BookingOpsSafeAction | null
  /** For optimistic concurrency on assign / acknowledge / escalate: 0 when no operational state exists yet. */
  opsVersion: number
  /** Only on the Resolved tab: when the case last had operational activity. */
  lastActivityAt: string | null
}
export interface BookingOpsQueuePage {
  items: BookingOpsQueueItem[]
  total: number
  page: number
  pageSize: number
  tab: BookingOpsTab
  counts: BookingOpsCounts
  /** True when more candidate bookings exist than the scan cap: counts and order cover the newest `BOOKING_OPS_SCAN_CAP`. */
  scanCapped: boolean
  /** The SLA targets in force (minutes), so the screen can state them. */
  slaPolicy: BookingOpsSlaPolicy
  generatedAt: string
  /** The caller, so "claim" can assign to themselves without the browser guessing an id. */
  viewer: { id: string }
  /** What the caller may do on this page (permission only; the API re-checks every action). */
  can: { assign: boolean; escalate: boolean; resolve: boolean; note: boolean; supplierRetry: boolean }
}
export type BookingOpsCounts = Record<Exclude<BookingOpsTab, 'resolved'>, number> & { resolved: number }

export interface BookingOpsAssignee { id: string; name: string }
export interface BookingOpsTimelineItem { at: string; kind: 'event' | 'derived'; title: string; actorName: string | null; reason: string | null }
export interface BookingOperationsPanel {
  /** The caller, so "claim" assigns to themselves without the browser guessing an id. */
  viewerId: string
  item: BookingOpsQueueItem
  /** What this caller may do now (permission and booking state both considered). */
  can: { assign: boolean; acknowledge: boolean; escalate: boolean; note: boolean; clearFollowUp: boolean; answers: BookingOpsAnswer[] }
  /** Recent operational events and derived markers (entered the queue, SLA due, SLA breached), newest last. Derived markers are computed, never stored. */
  timeline: BookingOpsTimelineItem[]
}

export interface BookingOpsAssignRequest { assigneeUserId: string | null; expectedVersion: number }
export interface BookingOpsAcknowledgeRequest { expectedVersion: number }
export interface BookingOpsEscalateRequest { priority: (typeof BOOKING_OPS_MANUAL_PRIORITIES)[number] | null; followUp?: boolean; reason: string; expectedVersion: number }
export interface BookingOpsNoteRequest { note: string }
export interface BookingOpsClearRequest { reason: string; expectedVersion: number }
export interface BookingOpsAnswerRequest {
  answer: BookingOpsAnswer
  /** CAS: the booking must still be in this status. */
  expectedStatus: BookingStatus
  reason: string
  supplierRef?: string
  hotelConfirmationNo?: string
  supplierCancellationRef?: string
  /** Who at the supplier said so, and any reference they gave: mandatory for "no booking exists". */
  evidenceRef?: string
}
export interface BookingOpsWriteResult { bookingId: string; reference: string; status: BookingStatus; opsVersion: number; replayed: boolean }
export const BOOKING_OPS_REASON_MIN = 10
