import { classifyPenaltyChange, documentBlock, effectivePenalty, parseFrozenRules, splitSell, type PenaltyFact, type StoredPenaltyQuote } from '@bedbanks/contracts'
import { renderBookingDocument } from '../agent/booking-document.render'
import { buildDocumentPayload, type DocumentBooking } from './booking-finance-documents'
import { buildPenaltyQuote } from './booking-penalty-quote'
import { validateManualBooking } from './manual-booking'

const NOW = new Date('2026-12-01T10:00:00Z')
const quoteInput = (over: Partial<Parameters<typeof buildPenaltyQuote>[0]> = {}) => ({ sellMinor: 100_000n, currency: 'AED', isRefundable: true as boolean | null, checkIn: '2026-12-10', rules: [{ daysBeforeCheckin: 14, penaltyPercent: 50 }, { daysBeforeCheckin: 3, penaltyPercent: 100 }] as unknown, requestedAt: NOW, timeZone: 'Asia/Dubai', ...over })

describe('BF: frozen cancellation terms and the penalty quote (ADR 0039, Phase 5)', () => {
  it('BF-01: rules are validated strictly; anything ambiguous is unavailable, never free', () => {
    expect(parseFrozenRules([{ daysBeforeCheckin: 7, penaltyPercent: 100 }])).toEqual([{ daysBeforeCheckin: 7, penaltyPercent: 100 }])
    for (const bad of [null, [], [{ daysBeforeCheckin: 7 }], [{ daysBeforeCheckin: 7, penaltyPercent: 10, penaltyMinor: '5' }], [{ daysBeforeCheckin: 7, penaltyPercent: 101 }], [{ daysBeforeCheckin: 7.5, penaltyPercent: 1 }], [{ daysBeforeCheckin: 7, penaltyMinor: '1.5' }], [{ daysBeforeCheckin: 7, penaltyMinor: '-1' }], [{ daysBeforeCheckin: -1, penaltyPercent: 1 }], 'x']) expect(parseFrozenRules(bad)).toBeNull()
  })

  it('BF-02: inside the 50% window the penalty is half, in integer minor units, and penalty + refund = sell', () => {
    const q = buildPenaltyQuote(quoteInput({ checkIn: '2026-12-10' })) // 9 days before check-in: inside the 14-day rule, outside the 3-day rule
    expect(q).toMatchObject({ status: 'quotable', penaltyMinor: '50000', refundMinor: '50000', ruleDaysBeforeCheckin: 14, basis: 'RULE' })
  })

  it('BF-03: odd amounts round down in integer arithmetic and still sum to the sell amount (no float)', () => {
    const q = buildPenaltyQuote(quoteInput({ sellMinor: 100_001n, rules: [{ daysBeforeCheckin: 14, penaltyPercent: 33 }] }))
    expect(q).toMatchObject({ status: 'quotable', penaltyMinor: '33000', refundMinor: '67001' })
    if (q.status === 'quotable') expect(BigInt(q.penaltyMinor) + BigInt(q.refundMinor)).toBe(100_001n)
  })

  it('BF-04: a fixed-amount rule larger than the sell amount is capped at the sell amount', () => {
    expect(buildPenaltyQuote(quoteInput({ sellMinor: 20_000n, rules: [{ daysBeforeCheckin: 14, penaltyMinor: '90000' }] }))).toMatchObject({ penaltyMinor: '20000', refundMinor: '0' })
  })

  it('BF-05: outside every rule window the whole amount is refundable', () => {
    expect(buildPenaltyQuote(quoteInput({ checkIn: '2027-03-01' }))).toMatchObject({ status: 'quotable', penaltyMinor: '0', refundMinor: '100000', ruleDaysBeforeCheckin: null })
  })

  it('BF-06: a non-refundable booking retains the whole amount and needs no rules', () => {
    expect(buildPenaltyQuote(quoteInput({ isRefundable: false, rules: null }))).toMatchObject({ status: 'quotable', penaltyMinor: '100000', refundMinor: '0', basis: 'NON_REFUNDABLE' })
  })

  it('BF-07: unknown refundability, missing terms and a missing check-in need a decision, never a guess', () => {
    expect(buildPenaltyQuote(quoteInput({ isRefundable: null }))).toMatchObject({ status: 'needs_decision', reason: 'refundability_unknown' })
    expect(buildPenaltyQuote(quoteInput({ rules: null }))).toMatchObject({ status: 'needs_decision', reason: 'policy_unavailable' })
    expect(buildPenaltyQuote(quoteInput({ checkIn: null }))).toMatchObject({ status: 'needs_decision', reason: 'manual_review_required' })
  })

  it('BF-08: the hotel time zone decides the boundary (the same instant is a different local day)', () => {
    const rules = [{ daysBeforeCheckin: 1, penaltyPercent: 100 }]
    const at = new Date('2026-12-09T21:00:00Z') // 01:00 on 10 Dec in Dubai (+4); 21:00 on 9 Dec in UTC
    expect(buildPenaltyQuote(quoteInput({ rules, requestedAt: at, timeZone: 'Asia/Dubai' }))).toMatchObject({ penaltyMinor: '100000' })
    expect(buildPenaltyQuote(quoteInput({ rules, requestedAt: new Date('2026-12-08T19:00:00Z'), timeZone: 'Asia/Dubai' }))).toMatchObject({ penaltyMinor: '0' })
  })
})

describe('BF: the effective penalty, waivers and decisions', () => {
  const quoted: StoredPenaltyQuote = { status: 'quotable', currency: 'AED', sellMinor: '100000', penaltyMinor: '50000', refundMinor: '50000', ruleDaysBeforeCheckin: 14, basis: 'RULE', evaluatedAt: NOW.toISOString() }
  const undecided: StoredPenaltyQuote = { status: 'needs_decision', reason: 'policy_unavailable', detail: 'x', evaluatedAt: NOW.toISOString() }
  const fact = (type: PenaltyFact['type'], penaltyMinor: string | null): PenaltyFact => ({ type, penaltyMinor, createdAt: NOW.toISOString() })
  const eff = (quote: StoredPenaltyQuote | null, facts: PenaltyFact[] = [], requested = true) => effectivePenalty({ sellMinor: '100000', requested, quote, facts })

  it('BF-09: no cancellation requested means no penalty; an undetermined quote is NEEDS_DECISION, not zero', () => {
    expect(eff(quoted, [], false)).toEqual({ state: 'NOT_REQUESTED' })
    expect(eff(undecided)).toMatchObject({ state: 'NEEDS_DECISION', reason: 'policy_unavailable' })
    expect(eff(null)).toMatchObject({ state: 'NEEDS_DECISION' })
  })

  it('BF-10: the quote taken at request time stands; a later waiver replaces it; a decision resolves an undecided quote', () => {
    expect(eff(quoted)).toEqual({ state: 'QUOTED', penaltyMinor: '50000', refundMinor: '50000' })
    expect(eff(quoted, [fact('PENALTY_WAIVED', '20000')])).toEqual({ state: 'WAIVED', penaltyMinor: '20000', refundMinor: '80000' })
    expect(eff(undecided, [fact('PENALTY_DECIDED', '100000')])).toEqual({ state: 'DECIDED', penaltyMinor: '100000', refundMinor: '0' })
    // A CANCELLED fact that recorded an unknown penalty does not count as an amount.
    expect(eff(undecided, [fact('CANCELLED', null)])).toMatchObject({ state: 'NEEDS_DECISION' })
  })

  it('BF-11: a penalty can be decided once, waived down, never raised, never equal, never above the sell amount', () => {
    const q = eff(quoted); const u = eff(undecided)
    expect(classifyPenaltyChange(u, 100_000n, 70_000n)).toEqual({ kind: 'DECIDE' })
    expect(classifyPenaltyChange(q, 100_000n, 20_000n)).toEqual({ kind: 'WAIVE' })
    expect(classifyPenaltyChange(q, 100_000n, 50_000n)).toEqual({ kind: 'REFUSE', code: 'PENALTY_UNCHANGED' })
    expect(classifyPenaltyChange(q, 100_000n, 60_000n)).toEqual({ kind: 'REFUSE', code: 'PENALTY_CANNOT_INCREASE' })
    expect(classifyPenaltyChange(q, 100_000n, 100_001n)).toEqual({ kind: 'REFUSE', code: 'PENALTY_INVALID' })
    expect(classifyPenaltyChange({ state: 'NOT_REQUESTED' }, 100_000n, 0n)).toEqual({ kind: 'REFUSE', code: 'PENALTY_NOT_OPEN' })
    expect(splitSell(10n, 11n)).toBeNull(); expect(splitSell(10n, -1n)).toBeNull()
  })
})

describe('BF: document eligibility', () => {
  const facts = (over: Partial<Parameters<typeof documentBlock>[1]> = {}) => ({ status: 'CONFIRMED' as const, hasConfirmedEvent: true, hotelConfirmationNo: 'HC-1', penalty: { state: 'NOT_REQUESTED' } as const, sellMinor: '100000', issued: [] as never[], ...over })
  const cancelled = (penaltyMinor: string, refundMinor: string, issued: Array<'INVOICE'> = ['INVOICE']) => facts({ status: 'CANCELLED', penalty: { state: 'QUOTED', penaltyMinor, refundMinor }, issued })

  it('BF-12: voucher and invoice need a confirmed booking; a voucher also needs the hotel confirmation number and is refused once cancelled', () => {
    expect(documentBlock('VOUCHER', facts())).toBeNull()
    expect(documentBlock('INVOICE', facts())).toBeNull()
    expect(documentBlock('VOUCHER', facts({ hotelConfirmationNo: null }))).toBe('HOTEL_CONFIRMATION_REQUIRED')
    expect(documentBlock('VOUCHER', facts({ hasConfirmedEvent: false }))).toBe('NOT_CONFIRMED')
    expect(documentBlock('VOUCHER', cancelled('1', '1'))).toBe('BOOKING_CANCELLED')
    expect(documentBlock('INVOICE', facts({ issued: ['INVOICE'] }))).toBe('ALREADY_ISSUED')
  })

  it('BF-13: cancellation documents need a cancelled booking, a determined penalty and (for the credit note) the invoice and something to credit', () => {
    expect(documentBlock('CREDIT_NOTE', facts())).toBe('NOT_CANCELLED')
    expect(documentBlock('CREDIT_NOTE', facts({ status: 'CANCELLED', penalty: { state: 'NEEDS_DECISION', reason: 'x' } }))).toBe('PENALTY_DECISION_REQUIRED')
    expect(documentBlock('CREDIT_NOTE', cancelled('50000', '50000', []))).toBe('INVOICE_REQUIRED')
    expect(documentBlock('CREDIT_NOTE', cancelled('50000', '50000'))).toBeNull()
    expect(documentBlock('CREDIT_NOTE', cancelled('100000', '0'))).toBe('NOTHING_TO_CREDIT')
    expect(documentBlock('CANCELLATION_NOTE', cancelled('100000', '0'))).toBeNull()
  })
})

describe('BF: document content', () => {
  const booking: DocumentBooking = { reference: 'FB-0123456789ABCDEF0123', currency: 'AED', totalMinor: 100_000n, paymentMode: 'CREDIT', isRefundable: true, hotelConfirmationNo: 'HC-77', agentRef: 'AG-9', checkIn: new Date('2026-12-10T00:00:00Z'), checkOut: new Date('2026-12-12T00:00:00Z'), nights: 2,
    cancellationPolicy: { rules: [{ daysBeforeCheckin: 14, penaltyPercent: 50 }], frozenAt: NOW.toISOString(), source: 'MANUAL_ENTRY' }, rooms: [{ roomName: 'Deluxe', boardCode: 'BB', adults: 2, children: 0, childAges: [] }], guests: [{ firstName: 'Ada', lastName: "O'Hara", isLead: true }] }
  const content = { issuedFor: 'Acme Travel', hotel: { name: 'Palm <Hotel>', city: 'Dubai', countryCode: 'AE' } }
  const penalty = { state: 'QUOTED', penaltyMinor: '50000', refundMinor: '50000' } as const
  const quote: StoredPenaltyQuote = { status: 'quotable', currency: 'AED', sellMinor: '100000', penaltyMinor: '50000', refundMinor: '50000', ruleDaysBeforeCheckin: 14, basis: 'RULE', evaluatedAt: NOW.toISOString() }
  const build = (type: Parameters<typeof buildDocumentPayload>[0]) => buildDocumentPayload(type, { booking: { ...booking, ...({ netMinor: 80_000n, supplier: 'Secret Supplier', supplierRef: 'SUP-1' } as object) }, content, penalty, quote, cancelledAt: NOW })
  const html = (type: Parameters<typeof buildDocumentPayload>[0]) => renderBookingDocument({ type, number: `N-${booking.reference}`, issuedAt: NOW.toISOString(), bookingStatus: 'CANCELLED', payload: build(type) })

  it('BF-14: the voucher shows what the hotel needs and never the net rate, markup, supplier name or supplier reference', () => {
    const p = JSON.stringify(build('VOUCHER')); const h = html('VOUCHER')
    for (const text of ['HC-77', 'AG-9', "O'Hara", 'Deluxe', 'BB', '2026-12-10', 'Acme Travel']) expect(p + h).toContain(text.replace("'", p.includes("O'Hara") ? "'" : '&#39;'))
    for (const secret of ['80000', 'Secret Supplier', 'SUP-1', 'netMinor', 'markup']) { expect(p).not.toContain(secret); expect(h).not.toContain(secret) }
    expect(h).toContain('Palm &lt;Hotel&gt;') // escaped
  })

  it('BF-15: the invoice is the sell total, with the payment terms in words and no net rate', () => {
    const p = build('INVOICE') as { totalMinor: string; lines: Array<{ amountMinor: string }>; payment: { text: string } }
    expect(p.totalMinor).toBe('100000'); expect(p.lines[0].amountMinor).toBe('100000'); expect(p.payment.text).toBe('On the agency credit account')
    expect(html('INVOICE')).toContain('AED 1,000.00'); expect(html('INVOICE')).not.toContain('Paid from wallet'); expect(JSON.stringify(p)).not.toContain('80000')
  })

  it('BF-16: cancel with a penalty: the credit note credits sell minus penalty and the cancellation note states the penalty, the refund and the rule', () => {
    const cn = build('CREDIT_NOTE') as { totalMinor: string; penaltyMinor: string; refundMinor: string; originalInvoiceNumber: string }
    expect(cn).toMatchObject({ totalMinor: '100000', penaltyMinor: '50000', refundMinor: '50000', originalInvoiceNumber: `INV-${booking.reference}` })
    const h = html('CREDIT_NOTE'); expect(h).toContain('AED 500.00'); expect(h).toContain('Credit against the invoice'); expect(h).not.toContain('wallet')
    const note = html('CANCELLATION_NOTE'); expect(note).toContain('Cancellation Note'); expect(note).toContain('AED 500.00'); expect(note).toContain('within 14 day(s) of check-in'); expect(note).not.toContain('THIS BOOKING HAS BEEN CANCELLED')
  })

  it('BF-17: a cancellation document cannot be built without a determined penalty', () => {
    expect(() => buildDocumentPayload('CREDIT_NOTE', { booking, content, penalty: { state: 'NEEDS_DECISION', reason: 'x' }, quote: null, cancelledAt: null })).toThrow()
  })
})

describe('BF: manual entry freezes the terms', () => {
  const body = { agencyId: 'a', hotelId: 'h', supplier: 'mock', checkIn: '2027-01-10', checkOut: '2027-01-12', currency: 'AED', sellMinor: '100000', isRefundable: true, rooms: [{ roomName: 'R', adults: 2 }], guests: [{ firstName: 'A', lastName: 'B' }] }
  it('BF-18: rules are validated, bounded by the sell amount, and refused on a non-refundable booking', () => {
    expect(validateManualBooking({ ...body, cancellationRules: [{ daysBeforeCheckin: 7, penaltyPercent: 100 }] }).cancellationRules).toEqual([{ daysBeforeCheckin: 7, penaltyPercent: 100 }])
    expect(validateManualBooking(body).cancellationRules).toBeNull()
    expect(() => validateManualBooking({ ...body, cancellationRules: [{ daysBeforeCheckin: 7, penaltyPercent: 1000 }] })).toThrow()
    expect(() => validateManualBooking({ ...body, cancellationRules: [{ daysBeforeCheckin: 7, penaltyMinor: '100001' }] })).toThrow()
    expect(() => validateManualBooking({ ...body, isRefundable: false, cancellationRules: [{ daysBeforeCheckin: 7, penaltyPercent: 10 }] })).toThrow()
  })
})
