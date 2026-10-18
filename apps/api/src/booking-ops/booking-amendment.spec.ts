import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  amendedCancelDeadline, amendedNetAndMarkup, amendmentDifference, BOOKING_ACTION_RULES, validateAmendmentApproval, validateAmendmentProposal,
  type AmendmentSubject,
} from '@bedbanks/contracts'
import { amendmentFingerprint, canonicalJson } from './booking-amendment'
import { requestFingerprint } from './booking-transition'

const TODAY = '2030-06-10'
const current: AmendmentSubject = { checkIn: '2030-07-01', checkOut: '2030-07-05', rooms: [{ position: 1, adults: 2, children: 1, childAges: [7] }, { position: 2, adults: 2, children: 0, childAges: [] }] }
const ok = (raw: unknown, subject: AmendmentSubject = current) => { const r = validateAmendmentProposal(raw, subject, TODAY); if (!r.ok) throw new Error(JSON.stringify(r.issues)); return r }
const issues = (raw: unknown, subject: AmendmentSubject = current) => { const r = validateAmendmentProposal(raw, subject, TODAY); return r.ok ? [] : r.issues.map((i) => i.field) }

describe('booking amendments: proposal (ADR 0072)', () => {
  it('AM-01: new dates are validated against the booking and the day; nights are recomputed; nothing changes unless something differs', () => {
    expect(ok({ checkOut: '2030-07-07' }).stay).toEqual({ checkIn: '2030-07-01', checkOut: '2030-07-07', nights: 6 })
    expect(ok({ checkIn: '2030-07-02', checkOut: '2030-07-06' }).changes).toEqual(['STAY_DATES'])
    expect(issues({ checkOut: '2030-07-01' })).toContain('checkOut')               // zero nights
    expect(issues({ checkOut: '2030-06-30' })).toContain('checkOut')               // before check-in
    expect(issues({ checkOut: '2030-09-30' })).toContain('checkOut')               // over 60 nights
    expect(issues({ checkIn: '2030-06-09', checkOut: '2030-07-05' })).toContain('checkIn') // moved into the past
    expect(issues({ checkIn: '2030-02-30' })).toContain('checkIn')                 // not a real date
    expect(issues({ checkIn: '2030-07-01', checkOut: '2030-07-05' })).toEqual(['*']) // identical: nothing would change
    expect(issues({})).toEqual(['*'])
    expect(issues({ checkOut: '2030-07-07', price: 5 })).toContain('price')       // unknown fields are refused, never ignored
  })

  it('AM-02: a stay already in progress can still be extended at check-out; its check-in is not "moved into the past" when unchanged', () => {
    const inProgress = { ...current, checkIn: '2030-06-08', checkOut: '2030-06-12' }
    expect(ok({ checkOut: '2030-06-14' }, inProgress).stay.nights).toBe(6)
    expect(issues({ checkIn: '2030-06-08', checkOut: '2030-06-14' }, inProgress)).toEqual([])
  })

  it('AM-03: a booking with no recorded dates needs both; one date alone is refused', () => {
    const none = { ...current, checkIn: null, checkOut: null }
    expect(issues({ checkIn: '2030-07-01' }, none)).toContain('checkIn')
    expect(ok({ checkIn: '2030-07-01', checkOut: '2030-07-03' }, none).stay.nights).toBe(2)
  })

  it('AM-04: occupancy: only rooms the booking has, head counts in range, one age per child; a same-as-now room is not a change', () => {
    expect(ok({ rooms: [{ position: 2, adults: 3, children: 0, childAges: [] }] }).changes).toEqual(['OCCUPANCY'])
    expect(ok({ rooms: [{ position: 1, adults: 2, children: 2, childAges: [9, 4] }] }).proposal.rooms).toEqual([{ position: 1, adults: 2, children: 2, childAges: [4, 9] }])
    expect(issues({ rooms: [{ position: 3, adults: 2, children: 0, childAges: [] }] })).toContain('rooms.0.position')
    expect(issues({ rooms: [{ position: 1, adults: 0, children: 0, childAges: [] }] })).toContain('rooms.0.adults')
    expect(issues({ rooms: [{ position: 1, adults: 10, children: 0, childAges: [] }] })).toContain('rooms.0.adults')
    expect(issues({ rooms: [{ position: 1, adults: 2, children: 2, childAges: [4] }] })).toContain('rooms.0.childAges')
    expect(issues({ rooms: [{ position: 1, adults: 2, children: 1, childAges: [18] }] })).toContain('rooms.0.childAges')
    expect(issues({ rooms: [{ position: 1, adults: 2, children: 1, childAges: [7] }] })).toEqual(['*'])
    expect(issues({ rooms: [{ position: 1, adults: 3, children: 0, childAges: [] }, { position: 1, adults: 2, children: 0, childAges: [] }] })).toContain('rooms.1.position')
    expect(issues({ rooms: [] })).toContain('rooms')
  })

  it('AM-05: dates and occupancy together report both changes; a proposal carries no guest data field at all', () => {
    expect(ok({ checkOut: '2030-07-07', rooms: [{ position: 2, adults: 1, children: 0, childAges: [] }] }).changes).toEqual(['STAY_DATES', 'OCCUPANCY'])
    expect(issues({ checkOut: '2030-07-07', guests: [{ firstName: 'A' }] })).toContain('guests')
    expect(issues({ rooms: [{ position: 1, adults: 3, children: 1, childAges: [7], name: 'A' }] })).toContain('rooms.0.name')
  })
})

describe('booking amendments: approval and money (ADR 0072)', () => {
  it('AM-06: the approver records integer minor units: a positive sell, an optional net not above it, an optional deadline; floats and junk are refused', () => {
    const good = validateAmendmentApproval({ sellMinor: '75000', netMinor: '60000', cancelDeadline: '2030-06-25T00:00:00.000Z' })
    expect(good).toMatchObject({ ok: true, approval: { sellMinor: 75000n, netMinor: 60000n } })
    for (const bad of [{}, { sellMinor: '0' }, { sellMinor: '-5' }, { sellMinor: '12.50' }, { sellMinor: 750 }, { sellMinor: '1e5' }, { sellMinor: '1234567890123456' }, { sellMinor: '100', netMinor: '101' }, { sellMinor: '100', netMinor: '1.5' }, { sellMinor: '100', cancelDeadline: 'tomorrow' }, { sellMinor: '100', extra: 1 }, null, [], 'x']) expect(validateAmendmentApproval(bad).ok).toBe(false)
    expect(validateAmendmentApproval({ sellMinor: '100', netMinor: null })).toMatchObject({ ok: true, approval: { netMinor: null } })
  })

  it('AM-07: the difference is signed integer arithmetic, with no rounding and no floating point', () => {
    expect(amendmentDifference('73000', '75000')).toEqual({ differenceMinor: '2000', direction: 'INCREASE' })
    expect(amendmentDifference('73000', '70500')).toEqual({ differenceMinor: '-2500', direction: 'DECREASE' })
    expect(amendmentDifference(73000n, 73000n)).toEqual({ differenceMinor: '0', direction: 'NONE' })
    expect(amendmentDifference('999999999999999', '1')).toEqual({ differenceMinor: '-999999999999998', direction: 'DECREASE' })
  })

  it('AM-08: a given net recomputes the markup; no net makes net and markup unknown, never stale', () => {
    expect(amendedNetAndMarkup(75000n, 60000n)).toEqual({ netMinor: 60000n, markupMinor: 15000n })
    expect(amendedNetAndMarkup(75000n, undefined)).toEqual({ netMinor: null, markupMinor: null })
    expect(amendedNetAndMarkup(75000n, null)).toEqual({ netMinor: null, markupMinor: null })
  })

  it('AM-09: the free-cancellation deadline: the recorded one wins; unchanged when the dates did not move; unknown when they did and none was recorded', () => {
    const was = new Date('2030-06-20T00:00:00.000Z'); const recorded = new Date('2030-06-25T00:00:00.000Z')
    expect(amendedCancelDeadline(was, ['STAY_DATES'], recorded)).toBe(recorded)
    expect(amendedCancelDeadline(was, ['STAY_DATES'], null)).toBeNull()
    expect(amendedCancelDeadline(was, ['STAY_DATES'], undefined)).toBeNull()
    expect(amendedCancelDeadline(was, ['OCCUPANCY'], undefined)).toBe(was)
  })
})

describe('booking amendments: idempotency and wiring (ADR 0072)', () => {
  it('AM-10: the fingerprint covers the structured body, whatever the key order; requests without one keep their old fingerprint exactly', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } })).toBe('{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}')
    expect(amendmentFingerprint('requestAmendment', { amendment: { checkOut: '2030-07-07', checkIn: '2030-07-01' } })).toBe(amendmentFingerprint('requestAmendment', { amendment: { checkIn: '2030-07-01', checkOut: '2030-07-07' } }))
    expect(amendmentFingerprint('requestAmendment', { amendment: { checkOut: '2030-07-07' } })).not.toBe(amendmentFingerprint('requestAmendment', { amendment: { checkOut: '2030-07-08' } }))
    expect(amendmentFingerprint('requestAmendment', {})).toBeUndefined(); expect(amendmentFingerprint('confirmCancellation', {})).toBeUndefined()
    const base = { action: 'requestAmendment' as const, expectedStatus: 'CONFIRMED' as const, reason: 'longer stay' }
    expect(requestFingerprint('bk1', base)).toBe(requestFingerprint('bk1', { ...base, fingerprintExtra: undefined }))
    expect(requestFingerprint('bk1', { ...base, fingerprintExtra: 'amendment:{}' })).not.toBe(requestFingerprint('bk1', base))
  })

  it('AM-11: the lifecycle rules still describe the three actions, and approval is for operators only', () => {
    expect(BOOKING_ACTION_RULES.requestAmendment).toMatchObject({ from: 'CONFIRMED', to: 'AMEND_REQUESTED', actors: ['OPERATOR', 'AGENCY'] })
    expect(BOOKING_ACTION_RULES.approveAmendment).toMatchObject({ from: 'AMEND_REQUESTED', to: 'CONFIRMED', actors: ['OPERATOR'], bumpsVersion: true })
    expect(BOOKING_ACTION_RULES.rejectAmendment).toMatchObject({ from: 'AMEND_REQUESTED', to: 'CONFIRMED', actors: ['OPERATOR'] })
  })

  it('AM-12: the stay, price and occupancy columns of an existing booking are written by the amendment function and nowhere else', () => {
    const SRC = join(__dirname, '..')
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const p = join(dir, name); return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(name) && !/\.(spec|e2e-spec)\.ts$/.test(name) ? [p] : [] })
    const GUARDED = /\b(totalMinor|netMinor|markupMinor|checkIn|checkOut|nights|cancelDeadline)\s*:/
    const calls = (src: string, model: string) => { const out: string[] = []; const re = new RegExp(`\\b${model}\\s*\\.\\s*(update|updateMany|upsert)\\s*\\(`, 'g'); let m: RegExpExecArray | null
      while ((m = re.exec(src))) { let d = 1; let i = m.index + m[0].length; while (i < src.length && d > 0) { const c = src[i++]; if (c === '(') d++; else if (c === ')') d-- } out.push(src.slice(m.index, i)) } return out }
    const offenders: string[] = []
    for (const file of files(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/'); if (rel === 'booking-ops/booking-amendment.ts') continue
      const src = readFileSync(file, 'utf8')
      for (const c of calls(src, 'booking')) if (GUARDED.test(c.replace(/where\s*:\s*\{[^}]*\}/g, ''))) offenders.push(`${rel}: ${c.slice(0, 70)}`)
      for (const c of calls(src, 'bookingRoom')) if (/\b(adults|children|childAges|sellMinor|netMinor)\s*:/.test(c.replace(/where\s*:\s*\{[^}]*\}/g, ''))) offenders.push(`${rel}: bookingRoom ${c.slice(0, 70)}`)
      // A permission verifier that asserts the role is DENIED (`... WHERE false`) is not a writer.
      if (/UPDATE\s+"Booking(Room)?"[^;]*\b(total_minor|net_minor|markup_minor|check_in|check_out|nights|cancel_deadline|adults|children|child_ages)\b/i.test(src.replace(/UPDATE[^`;]*WHERE false/gi, ''))) offenders.push(`${rel}: raw SQL`)
    }
    expect(offenders).toEqual([])
    const own = readFileSync(join(SRC, 'booking-ops/booking-amendment.ts'), 'utf8')
    expect(own).toContain('tx.booking.updateMany'); expect(own).toContain('tx.bookingRoom.updateMany')
    expect(own).not.toMatch(/ledgerEntry|wallet|\.cancellation\./i)             // it moves no money
    expect(own).not.toMatch(/status\s*:\s*'(CANCELLED|CHECKED_OUT|FAILED)'/)   // and never writes a status other than its own row's
  })
})
