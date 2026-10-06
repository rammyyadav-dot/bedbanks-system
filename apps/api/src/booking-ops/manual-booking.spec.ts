import { BadRequestException } from '@nestjs/common'
import type { ManualBookingRequest } from '@bedbanks/contracts'
import { validateManualBooking } from './manual-booking'

const ok = (): ManualBookingRequest => ({
  agencyId: 'ag1', hotelId: 'h1', supplier: 'Supplier One', checkIn: '2030-07-01', checkOut: '2030-07-04', currency: 'AED', sellMinor: '123456', netMinor: '100000', isRefundable: true,
  rooms: [{ roomName: 'Deluxe', boardCode: 'BB', adults: 2, children: 1, childAges: [6] }], guests: [{ firstName: 'Amira', lastName: 'Haddad' }, { firstName: 'Sam', lastName: 'Haddad', type: 'CHILD', age: 6 }],
})
const msg = (mut: (b: any) => void) => { const b = ok(); mut(b); try { validateManualBooking(b); return 'ACCEPTED' } catch (e) { expect(e).toBeInstanceOf(BadRequestException); return String((e as BadRequestException).getResponse() && ((e as BadRequestException).getResponse() as { message: string }).message) } }

describe('manual booking validation', () => {
  it('MB-01: a valid request normalises: integer minor units as bigint, nights computed, markup derived, first guest is the lead', () => {
    const v = validateManualBooking(ok())
    expect(v).toMatchObject({ nights: 3, sellMinor: 123456n, netMinor: 100000n, markupMinor: 23456n, currency: 'AED', paymentMode: null })
    expect(v.guests.map((g) => g.isLead)).toEqual([true, false]); expect(typeof v.sellMinor).toBe('bigint')
  })
  it('MB-02: money is whole minor units only: decimals, signs, exponents, empty and zero are refused', () => {
    for (const bad of ['12.50', '-5', '1e3', '', ' 5', '0x10', '99999999999999999']) expect(msg((b) => { b.sellMinor = bad })).not.toBe('ACCEPTED')
    expect(msg((b) => { b.sellMinor = '0' })).toMatch(/greater than zero/)
    expect(msg((b) => { b.sellMinor = 5000 })).not.toBe('ACCEPTED') // a JSON number is not accepted
    expect(msg((b) => { b.netMinor = '1.5' })).not.toBe('ACCEPTED')
  })
  it('MB-03: dates must be real, ordered and at most 365 nights; a disabled currency is refused', () => {
    expect(msg((b) => { b.checkIn = '2030-02-31' })).toMatch(/real date/); expect(msg((b) => { b.checkOut = '2030-07-01' })).toMatch(/1 to 365 nights/)
    expect(msg((b) => { b.checkOut = '2031-08-01' })).toMatch(/365/); expect(msg((b) => { b.currency = 'XTS' })).toMatch(/not enabled/); expect(msg((b) => { b.currency = 'ab' })).toMatch(/not enabled/)
  })
  it('MB-04: occupancy: one age per child, adults 1-9, rooms 1-9, one lead guest at most, names required', () => {
    expect(msg((b) => { b.rooms[0].childAges = [] })).toMatch(/one age per child/); expect(msg((b) => { b.rooms[0].adults = 0 })).toMatch(/adults/)
    expect(msg((b) => { b.rooms = [] })).toMatch(/1 to 9 rooms/); expect(msg((b) => { b.guests[0].isLead = true; b.guests[1].isLead = true })).toMatch(/lead/)
    expect(msg((b) => { b.guests[0].firstName = '  ' })).toMatch(/required/); expect(msg((b) => { b.guests = [] })).toMatch(/1 to 40 guests/)
  })
  it('MB-05: the cancellation deadline cannot be after check-in', () => {
    expect(msg((b) => { b.cancelDeadline = '2030-06-25T12:00:00Z' })).toBe('ACCEPTED'); expect(msg((b) => { b.cancelDeadline = '2030-07-05T12:00:00Z' })).toMatch(/after check-in/)
  })
})
