import { BadRequestException } from '@nestjs/common'
import { normalizeCcEmails, normalizeCheckout, validRecipient } from './checkout-details'

const occ = { rooms: 2, adults: 2, children: 1, childAges: [7], leadGuest: { firstName: 'Layla', lastName: "O'Hara" } }
const guests = [
  { roomNumber: 1, type: 'ADULT' as const, title: 'Mrs' as const, firstName: ' Layla ', lastName: "O'Hara" },
  { roomNumber: 1, type: 'ADULT' as const, title: 'Mr' as const, firstName: 'Omar', lastName: "O'Hara" },
  { roomNumber: 1, type: 'CHILD' as const, firstName: 'Zain', lastName: "O'Hara", age: 7 },
  { roomNumber: 2, type: 'ADULT' as const, firstName: 'Sara', lastName: 'Khan' },
  { roomNumber: 2, type: 'ADULT' as const, firstName: 'Ali', lastName: 'Khan' },
  { roomNumber: 2, type: 'CHILD' as const, firstName: 'Noor', lastName: 'Khan', age: 7 },
]
const code = (fn: () => unknown) => { try { fn() } catch (error) { return error instanceof BadRequestException ? (error.getResponse() as { code: string }).code : 'OTHER' } return 'ACCEPTED' }

describe('checkout details (ADR 0066)', () => {
  it('accepts every guest per room, marks room 1’s first adult as lead and trims names', () => {
    const out = normalizeCheckout({ guests, agentRef: ' TR-2026/0412 ', specialRequests: { codes: ['QUIET_ROOM', 'LATE_CHECK_IN', 'QUIET_ROOM'], note: '  Arriving\n at 23:30 ' } }, occ)
    expect(out.guests).toHaveLength(6)
    expect(out.guests!.filter((g) => g.isLead)).toEqual([expect.objectContaining({ roomNumber: 1, firstName: 'Layla', title: 'Mrs' })])
    expect(out.guests!.find((g) => g.firstName === 'Noor')).toMatchObject({ roomNumber: 2, type: 'CHILD', age: 7, title: null })
    expect(out.agentRef).toBe('TR-2026/0412')
    expect(out.specialRequests).toEqual({ codes: ['LATE_CHECK_IN', 'QUIET_ROOM'], note: 'Arriving at 23:30' })
  })

  it('keeps the old lead-guest-only checkout working: nothing provided, nothing stored', () => {
    expect(normalizeCheckout({}, occ)).toEqual({ guests: null, agentRef: null, specialRequests: null })
    expect(normalizeCheckout({ agentRef: '   ', specialRequests: { codes: [] } }, occ)).toEqual({ guests: null, agentRef: null, specialRequests: null })
  })

  it('refuses guests that do not match the held occupancy, ages or lead guest', () => {
    expect(code(() => normalizeCheckout({ guests: guests.slice(0, 5) }, occ))).toBe('GUEST_COUNT_MISMATCH')
    expect(code(() => normalizeCheckout({ guests: guests.map((g, i) => i === 5 ? { ...g, roomNumber: 1 } : g) }, occ))).toBe('ROOM_OCCUPANCY_MISMATCH')
    expect(code(() => normalizeCheckout({ guests: guests.map((g, i) => i === 5 ? { ...g, age: 8 } : g) }, occ))).toBe('CHILD_AGE_MISMATCH')
    expect(code(() => normalizeCheckout({ guests: guests.map((g, i) => i === 0 ? { ...g, firstName: 'Someone' } : g) }, occ))).toBe('LEAD_GUEST_MISMATCH')
    expect(code(() => normalizeCheckout({ guests: guests.map((g, i) => i === 3 ? { ...g, firstName: '<b>x</b>' } : g) }, occ))).toBe('GUEST_NAME_INVALID')
    expect(code(() => normalizeCheckout({ guests: guests.map((g, i) => i === 3 ? { ...g, title: 'Dr' as never } : g) }, occ))).toBe('GUEST_TITLE_INVALID')
    expect(code(() => normalizeCheckout({ guests: guests.map((g, i) => i === 3 ? { ...g, age: 30 } : g) }, occ))).toBe('GUEST_AGE_INVALID')
  })

  it('bounds the agent reference and special requests', () => {
    expect(code(() => normalizeCheckout({ agentRef: 'x'.repeat(61) }, occ))).toBe('AGENT_REF_INVALID')
    expect(code(() => normalizeCheckout({ agentRef: '<script>' }, occ))).toBe('AGENT_REF_INVALID')
    expect(code(() => normalizeCheckout({ specialRequests: { codes: ['FREE_UPGRADE' as never] } }, occ))).toBe('SPECIAL_REQUEST_INVALID')
    expect(code(() => normalizeCheckout({ specialRequests: { codes: ['TWIN_BEDS', 'DOUBLE_BED'] } }, occ))).toBe('SPECIAL_REQUEST_CONFLICT')
    expect(code(() => normalizeCheckout({ specialRequests: { codes: [], note: 'x'.repeat(301) } }, occ))).toBe('SPECIAL_REQUEST_NOTE_TOO_LONG')
  })

  it('CC emails: valid, de-duplicated, never the primary recipient, at most three', () => {
    expect(normalizeCcEmails([' Ops@Agency.example ', 'ops@agency.example', 'agent@agency.example', ''], 'agent@agency.example')).toEqual(['ops@agency.example'])
    expect(code(() => normalizeCcEmails(['not-an-email'], null))).toBe('CC_EMAIL_INVALID')
    expect(code(() => normalizeCcEmails(['a@x.example', 'b@x.example', 'c@x.example', 'd@x.example'], null))).toBe('CC_EMAIL_TOO_MANY')
    expect(validRecipient(' Agent@Agency.Example ')).toBe('agent@agency.example')
    expect(validRecipient('preview-agent@example')).toBeNull()
    expect(validRecipient(undefined)).toBeNull()
  })
})
