import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_BOOKING_OPS_SLA_POLICY, evaluateBookingOps, toUrgency, urgencyBadge, type BookingOpsFacts } from '@bedbanks/contracts'

const NOW = new Date('2030-06-10T10:00:00.000Z')
const facts = (over: Partial<BookingOpsFacts> = {}): BookingOpsFacts => ({
  status: 'PENDING_SUPPLIER', closed: false, supplierStatus: null, supplierConfigured: true, supplierRef: null, createdAt: '2030-06-10T09:50:00.000Z', checkIn: '2030-07-20', latestJob: null, hasActiveJob: true, failedCalls: 0,
  lastSupplierActivityAt: null, enteredStatusAt: {}, supplierUnknownAt: null, cancelFailedAt: null, ops: null, ...over,
})

describe('list urgency badge (ADR 0039, Phase 6F)', () => {
  it('UB-01: the badge is the queue\'s verdict: Urgent or Critical cases only, never HIGH, NORMAL, a non-case or an unknown verdict', () => {
    expect(urgencyBadge({ inQueue: true, priority: 'URGENT', slaState: null, primaryReason: null })).toBe('URGENT')
    expect(urgencyBadge({ inQueue: true, priority: 'CRITICAL', slaState: 'BREACHED', primaryReason: null })).toBe('CRITICAL')
    for (const priority of ['NORMAL', 'HIGH'] as const) expect(urgencyBadge({ inQueue: true, priority, slaState: null, primaryReason: null })).toBeNull()
    expect(urgencyBadge({ inQueue: false, priority: 'URGENT', slaState: null, primaryReason: null })).toBeNull()
    expect(urgencyBadge(null)).toBeNull(); expect(urgencyBadge(undefined)).toBeNull()
  })

  it('UB-02: it derives from the one ruleset, so the badge and the queue cannot disagree, and it clears itself when the rule stops being true', () => {
    const unknown = facts({ supplierUnknownAt: '2030-06-10T09:30:00.000Z', supplierStatus: 'UNKNOWN', hasActiveJob: false })
    const urgent = toUrgency(evaluateBookingOps(unknown, NOW, DEFAULT_BOOKING_OPS_SLA_POLICY))
    expect(urgent).toMatchObject({ inQueue: true, primaryReason: 'SUPPLIER_UNKNOWN' }); expect(urgencyBadge(urgent)).not.toBeNull()
    const settled = toUrgency(evaluateBookingOps(facts({ status: 'CONFIRMED', supplierRef: 'S-1', hasActiveJob: false }), NOW, DEFAULT_BOOKING_OPS_SLA_POLICY))
    expect(settled.inQueue).toBe(false); expect(urgencyBadge(settled)).toBeNull()
  })

  it('UB-03: wiring. The list asks only for callers who can see the queue, a failure is logged (not swallowed silently) and the page says so; the export never carries it', () => {
    const svc = readFileSync(join(__dirname, '../admin-operations/operations-bookings.service.ts'), 'utf8')
    const urgency = svc.slice(svc.indexOf('private async urgency('), svc.indexOf('private async names('))
    expect(urgency).toContain('if (!access.opsQueue) return null'); expect(urgency).toContain('this.logger.warn')
    expect(svc).toContain('urgencyAvailable: urgency !== null')
    const exportBody = svc.slice(svc.indexOf('async exportCsv'), svc.indexOf('private async urgency('))
    expect(exportBody).not.toContain('urgency')
  })
})
