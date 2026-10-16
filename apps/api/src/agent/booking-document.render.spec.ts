import { escapeHtml, formatMinor, renderBookingDocument, type RenderableDocument } from './booking-document.render'
import { documentKindFromRoute } from './booking-document.service'

const base = { bookingReference: 'FB-ABC123', issuedFor: 'Acme Travel', hotel: { name: 'Marina <b>Hotel</b>', city: 'Dubai', countryCode: 'AE' }, room: { name: 'Deluxe "King"' }, board: { code: 'BB', name: 'Bed & Breakfast' },
  stay: { checkIn: '2099-03-01', checkOut: '2099-03-03', nights: 2, rooms: 1, adults: 2, children: 1, childAges: [7] }, leadGuest: { firstName: '<script>alert(1)</script>', lastName: "O'Brien" } }
const doc = (type: RenderableDocument['type'], payload: object, bookingStatus = 'CONFIRMED'): RenderableDocument => ({ type, number: `${type}-1`, issuedAt: '2099-01-01T00:00:00.000Z', bookingStatus, payload: { ...base, ...payload } })

describe('formatMinor', () => {
  it('formats integer minor units by currency digits without floating point', () => {
    expect(formatMinor('125099', 'AED')).toBe('AED 1,250.99')
    expect(formatMinor('5', 'AED')).toBe('AED 0.05')
    expect(formatMinor('1500', 'JPY')).toBe('JPY 1,500')
    expect(formatMinor('1234', 'KWD')).toBe('KWD 1.234')
    expect(formatMinor('9007199254740993', 'USD')).toBe('USD 90,071,992,547,409.93')
    expect(formatMinor('-250', 'AED')).toBe('-AED 2.50')
    expect(formatMinor('12.5', 'AED')).toBe('—'); expect(formatMinor('100', 'aed')).toBe('—')
  })
})

describe('renderBookingDocument', () => {
  it('escapes every dynamic value and contains no script or external resource', () => {
    const html = renderBookingDocument(doc('VOUCHER', { cancellationPolicy: [{ daysBeforeCheckin: 7, penalty: '<img src=x onerror=1>' }] }))
    expect(html).not.toContain('<script'); expect(html).not.toContain('<img'); expect(html).not.toMatch(/https?:\/\//)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;'); expect(html).toContain('O&#39;Brien'); expect(html).toContain('Marina &lt;b&gt;Hotel&lt;/b&gt;'); expect(html).toContain('Deluxe &quot;King&quot;')
    expect(escapeHtml(undefined)).toBe('')
  })
  it('voucher shows stay and cancellation policy but no price', () => {
    const html = renderBookingDocument(doc('VOUCHER', { cancellationPolicy: [{ daysBeforeCheckin: 7, penalty: '100% of the booking total' }] }))
    expect(html).toContain('Hotel Voucher'); expect(html).toContain('2099-03-01'); expect(html).toContain('Within 7 day(s) of check-in: 100% of the booking total'); expect(html).toContain('ages 7')
    expect(html).not.toMatch(/AED\s?\d/)
  })
  it('invoice shows the charge in the booking currency; credit note shows penalty and refund', () => {
    const invoice = renderBookingDocument(doc('INVOICE', { currency: 'AED', lines: [{ description: 'Accommodation', amountMinor: '125099' }], totalMinor: '125099', payment: { status: 'PAID' } }))
    expect(invoice).toContain('AED 1,250.99'); expect(invoice).toContain('Tax Invoice')
    const note = renderBookingDocument(doc('CREDIT_NOTE', { currency: 'AED', originalInvoiceNumber: 'INV-FB-ABC123', totalMinor: '125099', penaltyMinor: '37529', refundMinor: '87570' }, 'CANCELLED'))
    expect(note).toContain('AED 375.29'); expect(note).toContain('AED 875.70'); expect(note).toContain('INV-FB-ABC123'); expect(note).not.toContain('THIS BOOKING HAS BEEN CANCELLED')
  })
  it('ADR 0066: voucher prints every guest by room, special requests as not guaranteed, agent ref and hotel times; still no price', () => {
    const html = renderBookingDocument(doc('VOUCHER', {
      agentRef: 'TR-<9>', hotelDetails: { address: '1 Marina Walk', checkInTime: '15:00', checkOutTime: '12:00' },
      guestsByRoom: [{ room: 1, guests: [{ name: 'Mrs Layla <O>', type: 'ADULT', age: null, isLead: true }, { name: 'Zain', type: 'CHILD', age: 7, isLead: false }] }, { room: 2, guests: [{ name: 'Mr Ali Khan', type: 'ADULT', age: null, isLead: false }] }],
      specialRequests: { items: ['Late check-in', 'Quiet room'], note: 'Arriving <late>' }, cancellationPolicy: [],
    }))
    expect(html).toContain('Rooming list'); expect(html).toContain('Room 2'); expect(html).toContain('Mrs Layla &lt;O&gt;'); expect(html).toContain('Lead guest'); expect(html).toContain('Child, age 7')
    expect(html).toContain('Not guaranteed'); expect(html).toContain('Late check-in'); expect(html).toContain('Arriving &lt;late&gt;')
    expect(html).toContain('Agent reference'); expect(html).toContain('TR-&lt;9&gt;'); expect(html).toContain('2099-03-01 from 15:00'); expect(html).toContain('1 Marina Walk')
    expect(html).not.toMatch(/AED\s?\d/); expect(html).not.toContain('<O>')
  })
  it('ADR 0066: invoice names the agency billed and the rooming list', () => {
    const html = renderBookingDocument(doc('INVOICE', { agencyName: 'Acme & Co', currency: 'AED', lines: [{ description: 'Accommodation', amountMinor: '90000' }], totalMinor: '90000', payment: { status: 'PAID' }, guestsByRoom: [{ room: 1, guests: [{ name: 'Mr A B', type: 'ADULT', age: null, isLead: true }] }] }))
    expect(html).toContain('Billed to'); expect(html).toContain('Acme &amp; Co'); expect(html).toContain('Rooming list'); expect(html).toContain('AED 900.00')
  })
  it('marks a voucher and invoice of a cancelled booking as no longer valid', () => {
    expect(renderBookingDocument(doc('VOUCHER', {}, 'CANCELLED'))).toContain('THIS BOOKING HAS BEEN CANCELLED')
    expect(renderBookingDocument(doc('INVOICE', { currency: 'AED', lines: [], totalMinor: '1', payment: {} }, 'CANCELLED'))).toContain('THIS BOOKING HAS BEEN CANCELLED')
  })
})

describe('documentKindFromRoute', () => {
  it('maps route segments and rejects anything else', () => {
    expect(documentKindFromRoute('voucher')).toBe('VOUCHER'); expect(documentKindFromRoute('credit-note')).toBe('CREDIT_NOTE')
    expect(() => documentKindFromRoute('receipt')).toThrow('Unknown document type'); expect(() => documentKindFromRoute('__proto__')).toThrow()
  })
})
