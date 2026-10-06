import { BookingStatus } from '@prisma/client'
import { AGENT_BOOKING_STATUSES, isAgentBookingStatus, statusesForAgentFilter, toAgentBookingStatus } from './agent-booking-status'

describe('Agent booking status vocabulary (ADR 0039)', () => {
  const all = Object.values(BookingStatus)

  it('maps every one of the ten statuses to exactly one of the four Agent values', () => {
    expect(all).toHaveLength(10)
    for (const status of all) expect(AGENT_BOOKING_STATUSES).toContain(toAgentBookingStatus(status))
  })

  it('leaves the four pre-migration values meaning what they meant', () => {
    expect(toAgentBookingStatus('PENDING_SUPPLIER')).toBe('PENDING')
    expect(toAgentBookingStatus('CONFIRMED')).toBe('CONFIRMED')
    expect(toAgentBookingStatus('CANCELLED')).toBe('CANCELLED')
    expect(toAgentBookingStatus('FAILED')).toBe('FAILED')
  })

  it('never shows an in-flight cancel as confirmed (it must not be cancellable again) or a rejection as pending', () => {
    expect(toAgentBookingStatus('CANCEL_REQUESTED')).toBe('PENDING')
    expect(toAgentBookingStatus('REJECTED')).toBe('FAILED')
    expect(toAgentBookingStatus('ON_REQUEST')).toBe('PENDING')
  })

  it('filters are the exact inverse of the mapping, with no status lost or counted twice', () => {
    const covered = AGENT_BOOKING_STATUSES.flatMap((value) => statusesForAgentFilter(value))
    expect([...covered].sort()).toEqual([...all].sort())
    for (const value of AGENT_BOOKING_STATUSES) for (const status of statusesForAgentFilter(value)) expect(toAgentBookingStatus(status)).toBe(value)
  })

  it('accepts only the four Agent values as a filter', () => {
    expect(isAgentBookingStatus('PENDING')).toBe(true)
    expect(isAgentBookingStatus('PENDING_SUPPLIER')).toBe(false)
    expect(isAgentBookingStatus('ON_REQUEST')).toBe(false)
  })
})
