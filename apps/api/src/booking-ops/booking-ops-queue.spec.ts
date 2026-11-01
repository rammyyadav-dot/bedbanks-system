import {
  answersFor, BOOKING_OPS_ANSWER_RULES, BOOKING_OPS_REASONS, bookingOpsReasons, bookingOpsTabIncludes, compareBookingOps, DEFAULT_BOOKING_OPS_SLA_POLICY, evaluateBookingOps, parseBookingOpsSlaPolicy,
  type BookingOpsFacts, type BookingOpsJobFacts, type BookingOpsStateFacts,
} from '@bedbanks/contracts'

const NOW = new Date('2030-06-10T12:00:00.000Z')
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()
const job = (over: Partial<BookingOpsJobFacts> = {}): BookingOpsJobFacts => ({ kind: 'BOOK', status: 'SUCCEEDED', attempt: 1, maxAttempts: 4, lastErrorCode: null, updatedAt: minsAgo(1), ...over })
const ops = (over: Partial<BookingOpsStateFacts> = {}): BookingOpsStateFacts => ({ version: 1, assigneeUserId: null, assignedAt: null, acknowledgedAt: null, manualPriority: null, escalatedAt: null, followUp: false, followUpAt: null, resolvedAt: null, ...over })
const facts = (over: Partial<BookingOpsFacts> = {}): BookingOpsFacts => ({
  status: 'PENDING_SUPPLIER', closed: false, supplierStatus: null, supplierConfigured: true, supplierRef: null, createdAt: minsAgo(5), checkIn: '2030-08-01', latestJob: null, hasActiveJob: false, failedCalls: 0,
  lastSupplierActivityAt: null, enteredStatusAt: {}, supplierUnknownAt: null, cancelFailedAt: null, ops: null, ...over,
})
const ev = (over: Partial<BookingOpsFacts> = {}, now = NOW) => evaluateBookingOps(facts(over), now)

describe('queue membership: derived from facts, not from a UI list', () => {
  it('OQ-01: pending supplier enters the queue; a confirmed booking with a reference does not; a closed booking never does', () => {
    expect(ev().inQueue).toBe(true); expect(ev().primaryReason).toBe('PENDING_SUPPLIER')
    expect(ev({ status: 'CONFIRMED', supplierRef: 'SUP-1' }).inQueue).toBe(false)
    expect(ev({ status: 'CANCELLED' }).inQueue).toBe(false); expect(ev({ status: 'FAILED' }).inQueue).toBe(false)
    expect(ev({ closed: true, status: 'PENDING_SUPPLIER', supplierStatus: 'UNKNOWN' }).inQueue).toBe(false)
  })
  it('OQ-02: a confirmed booking missing its supplier reference is a warning case, not a failure', () => {
    const e = ev({ status: 'CONFIRMED', supplierRef: null, enteredStatusAt: { CONFIRMED: minsAgo(10) } })
    expect(e).toMatchObject({ inQueue: true, primaryReason: 'MISSING_SUPPLIER_REF', priority: 'NORMAL', safeAction: 'ADD_SUPPLIER_REFERENCE' })
  })
  it('OQ-03: UNKNOWN is shown as unknown, never as failed; it is uncertain and the only safe action is a sync, never a resend', () => {
    const e = ev({ supplierStatus: 'UNKNOWN', latestJob: job({ kind: 'BOOK', status: 'UNKNOWN', lastErrorCode: 'SUPPLIER_UNREACHABLE' }), supplierUnknownAt: minsAgo(2) })
    expect(e.reasons).toEqual(['SUPPLIER_UNKNOWN', 'PENDING_SUPPLIER']); expect(e.primaryReason).toBe('SUPPLIER_UNKNOWN')
    expect(e.supplierCertainty).toBe('UNCERTAIN'); expect(e.safeAction).toBe('SYNC_WITH_SUPPLIER'); expect(e.priority).toBe('URGENT')
    expect(e.reasons).not.toContain('SUPPLIER_JOB_EXHAUSTED')
    expect(ev({ supplierStatus: 'UNKNOWN', supplierConfigured: false }).safeAction).toBe('RECORD_SUPPLIER_ANSWER') // cannot sync: a person asks the supplier
  })
  it('OQ-04: a cancellation the supplier did not confirm is URGENT and stays a Cancel requested case', () => {
    const e = ev({ status: 'CANCEL_REQUESTED', supplierStatus: 'CANCEL_FAILED', latestJob: job({ kind: 'CANCEL', status: 'FAILED', lastErrorCode: 'CANCEL_NOT_ALLOWED' }), cancelFailedAt: minsAgo(1), enteredStatusAt: { CANCEL_REQUESTED: minsAgo(30) } })
    expect(e.reasons).toEqual(['CANCELLATION_FAILED', 'CANCEL_REQUESTED']); expect(e.priority).toBe('URGENT'); expect(e.safeAction).toBe('SETTLE_CANCELLATION')
    expect(ev({ status: 'CANCEL_REQUESTED', enteredStatusAt: { CANCEL_REQUESTED: minsAgo(1) } })).toMatchObject({ primaryReason: 'CANCEL_REQUESTED', priority: 'HIGH', safeAction: 'SEND_CANCELLATION' })
  })
  it('OQ-05: exhausted and unconfigured supplier jobs are their own reasons; a settled-by-hand job is not', () => {
    expect(ev({ latestJob: job({ status: 'FAILED', attempt: 4, lastErrorCode: 'SUPPLIER_TIMEOUT' }) }).reasons).toContain('SUPPLIER_JOB_EXHAUSTED')
    expect(ev({ latestJob: job({ status: 'FAILED', attempt: 1, lastErrorCode: 'SUPPLIER_NOT_CONFIGURED' }) }).reasons).toContain('SUPPLIER_NOT_CONFIGURED')
    expect(ev({ latestJob: job({ status: 'FAILED', attempt: 4, lastErrorCode: 'ALREADY_APPLIED' }) }).reasons).toEqual(['PENDING_SUPPLIER'])
    expect(ev({ latestJob: job({ status: 'SUCCEEDED', lastErrorCode: 'MANUAL_NO_BOOKING' }), supplierStatus: 'NOT_FOUND' }).safeAction).toBe('SEND_TO_SUPPLIER') // safe to send again, and only now
  })
  it('OQ-06: on request, amendment requested and a manual follow-up are queue reasons; resolving the follow-up removes it', () => {
    expect(ev({ status: 'ON_REQUEST', enteredStatusAt: { ON_REQUEST: minsAgo(60) } }).primaryReason).toBe('ON_REQUEST')
    expect(ev({ status: 'AMEND_REQUESTED' }).primaryReason).toBe('AMEND_REQUESTED')
    const fu = ev({ status: 'CONFIRMED', supplierRef: 'S', ops: ops({ followUp: true, followUpAt: minsAgo(20) }) }); expect(fu).toMatchObject({ inQueue: true, primaryReason: 'MANUAL_FOLLOW_UP', safeAction: 'FOLLOW_UP' })
    expect(ev({ status: 'CONFIRMED', supplierRef: 'S', ops: ops({ followUp: true, followUpAt: minsAgo(20), resolvedAt: minsAgo(1) }) }).inQueue).toBe(false)
  })
  it('OQ-07: the reasons are listed in the documented precedence and the primary is the first', () => {
    const e = ev({ status: 'CANCEL_REQUESTED', supplierStatus: 'UNKNOWN', latestJob: job({ kind: 'CANCEL', status: 'UNKNOWN' }) })
    expect([...e.reasons]).toEqual(BOOKING_OPS_REASONS.filter((r) => e.reasons.includes(r))); expect(e.primaryReason).toBe('SUPPLIER_UNKNOWN')
    expect(bookingOpsReasons(facts({ closed: true }))).toEqual([])
  })
})

describe('SLA: one ruleset, derived at read time with an injected clock', () => {
  it('OQ-08: due time = entered + the reason’s target; the state follows the clock with no stored flag', () => {
    const f = facts({ createdAt: minsAgo(0) }) // pending supplier target is 30 minutes
    const at = (m: number) => evaluateBookingOps(f, new Date(NOW.getTime() + m * 60_000))
    expect(at(0)).toMatchObject({ slaTargetMinutes: 30, slaState: 'WITHIN_SLA', slaRemainingSeconds: 1800 }); expect(at(0).slaDueAt).toBe(new Date(NOW.getTime() + 30 * 60_000).toISOString())
    expect(at(22).slaState).toBe('WITHIN_SLA'); expect(at(23)).toMatchObject({ slaState: 'DUE_SOON', slaRemainingSeconds: 420 }) // due soon inside the last 25% (7.5 min)
    expect(at(30).slaState).toBe('DUE_SOON'); expect(at(30).slaRemainingSeconds).toBe(0) // exactly due is not yet breached
    expect(at(31)).toMatchObject({ slaState: 'BREACHED', slaRemainingSeconds: -60 }); expect(at(97).slaRemainingSeconds).toBe(-97 * 60 + 1800)
  })
  it('OQ-09: each reason has its own clock from its own start: unknown counts from the moment it became unknown, not from creation', () => {
    const e = ev({ createdAt: minsAgo(500), supplierStatus: 'UNKNOWN', supplierUnknownAt: minsAgo(20) })
    expect(e).toMatchObject({ primaryReason: 'SUPPLIER_UNKNOWN', slaTargetMinutes: 15, slaState: 'BREACHED', enteredAt: minsAgo(20) }); expect(e.slaRemainingSeconds).toBe(-5 * 60)
  })
  it('OQ-10: a policy override changes the targets; an invalid override is an error, never silently the defaults', () => {
    const ok = parseBookingOpsSlaPolicy(JSON.stringify({ minutes: { PENDING_SUPPLIER: 10 }, dueSoonFraction: 0.5 }))
    expect(ok.ok && ok.policy.minutes.PENDING_SUPPLIER).toBe(10); expect(ok.ok && ok.policy.minutes.ON_REQUEST).toBe(DEFAULT_BOOKING_OPS_SLA_POLICY.minutes.ON_REQUEST)
    expect(evaluateBookingOps(facts({ createdAt: minsAgo(8) }), NOW, ok.ok ? ok.policy : undefined)).toMatchObject({ slaTargetMinutes: 10, slaState: 'DUE_SOON' })
    for (const bad of ['{', '[]', '{"minutes":{"PENDING_SUPPLIER":0}}', '{"minutes":{"PENDING_SUPPLIER":1.5}}', '{"minutes":{"NOPE":5}}', '{"typo":1}', '{"dueSoonFraction":1}', '{"minutes":{"ON_REQUEST":"60"}}', '{"minutes":{"ON_REQUEST":99999999}}']) expect({ bad, ok: parseBookingOpsSlaPolicy(bad).ok }).toEqual({ bad, ok: false })
    expect(parseBookingOpsSlaPolicy(undefined).ok).toBe(true); expect(parseBookingOpsSlaPolicy('  ').ok).toBe(true)
  })
})

describe('priority: deterministic, separate from lifecycle status', () => {
  it('OQ-11: base priority by reason, raised one level per fact, capped at Critical', () => {
    expect(ev({ createdAt: minsAgo(1) }).priority).toBe('NORMAL')
    expect(ev({ createdAt: minsAgo(45) })).toMatchObject({ priority: 'HIGH', slaState: 'BREACHED' }) // breached: Normal -> High
    expect(ev({ createdAt: minsAgo(45), checkIn: '2030-06-10' }).priority).toBe('URGENT') // breached and check-in within 24 hours
    expect(ev({ createdAt: minsAgo(45), checkIn: '2030-06-10', failedCalls: 3 }).priority).toBe('CRITICAL')
    expect(ev({ supplierStatus: 'UNKNOWN', supplierUnknownAt: minsAgo(60), checkIn: '2030-06-10', failedCalls: 5 }).priority).toBe('CRITICAL') // never beyond Critical
  })
  it('OQ-12: a manual escalation is a floor: it can raise but never lower, and clearing it restores the derived value', () => {
    expect(ev({ createdAt: minsAgo(1), ops: ops({ manualPriority: 'URGENT', escalatedAt: minsAgo(1) }) })).toMatchObject({ priority: 'URGENT', primaryReason: 'PENDING_SUPPLIER' })
    expect(ev({ supplierStatus: 'UNKNOWN', supplierUnknownAt: minsAgo(1), ops: ops({ manualPriority: 'HIGH' }) }).priority).toBe('URGENT')
    expect(ev({ createdAt: minsAgo(1), ops: ops({ manualPriority: null }) }).priority).toBe('NORMAL')
    expect(ev({ createdAt: minsAgo(1), ops: ops({ manualPriority: 'CRITICAL', resolvedAt: minsAgo(0) }) }).priority).toBe('NORMAL') // a resolved escalation no longer counts
  })
  it('OQ-13: lifecycle status is never an input that gets rewritten: the evaluation has no status field to change', () => {
    const e = ev(); expect(Object.keys(e)).not.toContain('status'); expect(e.priorityFactors.length).toBeGreaterThan(0)
  })
})

describe('ordering and tabs', () => {
  const items = (list: Array<[string, Partial<BookingOpsFacts>]>) => list.map(([id, f]) => ({ bookingId: id, evaluation: evaluateBookingOps(facts(f), NOW) }))
  it('OQ-14: Critical, Urgent, breached, due soon, then the oldest; ties break on id so pages never shuffle', () => {
    const rows = items([
      ['e', { createdAt: minsAgo(1) }], ['d', { createdAt: minsAgo(25) }], ['c', { createdAt: minsAgo(45) }], ['b', { supplierStatus: 'UNKNOWN', supplierUnknownAt: minsAgo(3) }],
      ['a', { createdAt: minsAgo(45), checkIn: '2030-06-10', failedCalls: 3 }], ['f', { createdAt: minsAgo(1) }], ['z', { createdAt: minsAgo(90) }],
    ])
    const sorted = [...rows].sort(compareBookingOps).map((r) => r.bookingId)
    expect(sorted).toEqual(['a', 'b', 'z', 'c', 'd', 'e', 'f'])
    expect([...rows].reverse().sort(compareBookingOps).map((r) => r.bookingId)).toEqual(sorted) // input order is irrelevant
    const pages = [sorted.slice(0, 3), sorted.slice(3, 6), sorted.slice(6)].flat(); expect(new Set(pages).size).toBe(sorted.length)
  })
  it('OQ-15: tabs are pure filters over the evaluation: mine, unassigned, breached, due soon, unknown, cancellation, on request', () => {
    const mine = evaluateBookingOps(facts({ createdAt: minsAgo(45), ops: ops({ assigneeUserId: 'u1', assignedAt: minsAgo(10) }) }), NOW)
    expect(bookingOpsTabIncludes('mine', mine, 'u1')).toBe(true); expect(bookingOpsTabIncludes('mine', mine, 'u2')).toBe(false); expect(bookingOpsTabIncludes('unassigned', mine, 'u1')).toBe(false)
    expect(bookingOpsTabIncludes('breached', mine, null)).toBe(true); expect(bookingOpsTabIncludes('dueSoon', mine, null)).toBe(false)
    expect(bookingOpsTabIncludes('unknown', ev({ supplierStatus: 'UNKNOWN' }), null)).toBe(true); expect(bookingOpsTabIncludes('cancellation', ev({ status: 'CANCEL_REQUESTED' }), null)).toBe(true)
    expect(bookingOpsTabIncludes('onRequest', ev({ status: 'ON_REQUEST' }), null)).toBe(true); expect(bookingOpsTabIncludes('active', ev({ status: 'CONFIRMED', supplierRef: 'x' }), null)).toBe(false)
  })
  it('OQ-16: an assignment older than the current case belongs to an earlier case: the new case starts unassigned', () => {
    const stale = evaluateBookingOps(facts({ supplierStatus: 'UNKNOWN', supplierUnknownAt: minsAgo(5), ops: ops({ assigneeUserId: 'u1', assignedAt: minsAgo(60), acknowledgedAt: minsAgo(59) }) }), NOW)
    expect(stale.assigneeUserId).toBeNull(); expect(stale.acknowledgedAt).toBeNull()
    const fresh = evaluateBookingOps(facts({ supplierStatus: 'UNKNOWN', supplierUnknownAt: minsAgo(5), ops: ops({ assigneeUserId: 'u1', assignedAt: minsAgo(2), acknowledgedAt: minsAgo(1) }) }), NOW)
    expect(fresh).toMatchObject({ assigneeUserId: 'u1', acknowledgedAt: minsAgo(1) })
  })
})

describe('manual supplier answers: named, evidenced, never a status picker', () => {
  it('OQ-17: which answers are valid from which status; nothing else', () => {
    expect(answersFor('PENDING_SUPPLIER', false)).toEqual(['SUPPLIER_CONFIRMED', 'SUPPLIER_ON_REQUEST', 'SUPPLIER_REJECTED', 'SUPPLIER_HAS_NO_BOOKING', 'STILL_AWAITING_SUPPLIER'])
    expect(answersFor('ON_REQUEST', false)).toEqual(['SUPPLIER_CONFIRMED', 'SUPPLIER_REJECTED', 'STILL_AWAITING_SUPPLIER'])
    expect(answersFor('CANCEL_REQUESTED', false)).toEqual(['SUPPLIER_CANCELLED', 'SUPPLIER_REFUSED_CANCELLATION', 'STILL_AWAITING_SUPPLIER'])
    for (const s of ['CONFIRMED', 'CANCELLED', 'FAILED', 'REJECTED', 'CHECKED_OUT', 'NO_SHOW', 'AMEND_REQUESTED'] as const) expect(answersFor(s, false)).toEqual([])
    expect(answersFor('PENDING_SUPPLIER', true)).toEqual([])
  })
  it('OQ-18: "supplier has no booking" is not "supplier rejected": it does not move the status, needs evidence and an idle queue; rejection is a different answer', () => {
    const r = BOOKING_OPS_ANSWER_RULES
    expect(r.SUPPLIER_HAS_NO_BOOKING).toMatchObject({ movesStatus: false, requires: ['evidence'], needsNoActiveJob: true }); expect(r.SUPPLIER_REJECTED.movesStatus).toBe(true)
    expect(r.SUPPLIER_CONFIRMED.requires).toEqual(['reference']); expect(r.SUPPLIER_CANCELLED.requires).toEqual(['reference'])
    expect(Object.keys(r)).not.toContain('FAILED') // there is no generic "mark failed" for an unknown outcome
  })
})
