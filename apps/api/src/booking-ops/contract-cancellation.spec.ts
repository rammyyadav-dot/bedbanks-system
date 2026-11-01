import { recordAmendmentRequest } from './booking-amendment'
import { transitionBooking } from './booking-transition'
import { buildNoShowQuote, buildPenaltyQuote } from './booking-penalty-quote'
import { freezeCancellationTerms } from '../agent/booking-cancellation-terms'
import { validateManualBooking } from './manual-booking'
import { planPosting, type PostingEvent, type PostingFacts } from '../booking-finance-posting/posting-plan'

const rules = [{ daysBeforeCheckin: 3, penaltyPercent: 100, penaltyMinor: null, currency: null }, { kind: 'NO_SHOW', daysBeforeCheckin: 0, penaltyPercent: null, penaltyMinor: null, penaltyNights: 1, currency: null }]
const terms = freezeCancellationTerms(rules, 'AED', 'Flex', new Date('2026-10-01'), { bufferDays: 1, stayNights: 4, timeZone: 'Asia/Dubai', contractId: 'contract', contractVersion: 2, ratePlanId: 'plan' })!
const input = { sellMinor: 100_003n, currency: 'AED', isRefundable: true, checkIn: '2026-12-10', checkOut: '2026-12-14', rules: terms, requestedAt: new Date('2026-12-10T01:00:00Z'), timeZone: 'UTC' }

describe('Contract cancellation completion', () => {
  it('freezes provenance, buffer and hotel timezone with the sold terms', () => {
    expect(terms).toMatchObject({ contractId: 'contract', contractVersion: 2, ratePlanId: 'plan', timeZone: 'Asia/Dubai', bufferDays: 1, rules: [{ daysBeforeCheckin: 4, penaltyPercent: 100 }] })
    expect(freezeCancellationTerms(rules, 'AED', null, new Date(), { bufferDays: 0, stayNights: 4, timeZone: 'invalid' })).toBeNull()
  })
  it('a hotel timezone edit cannot change an existing buyer deadline', () => {
    const at = new Date('2026-12-05T21:00:00Z') // after Dubai midnight on day 4, before UTC midnight
    expect(buildPenaltyQuote({ ...input, requestedAt: at, timeZone: 'America/New_York' })).toMatchObject({ penaltyMinor: '100003' })
    expect(buildPenaltyQuote({ ...input, requestedAt: at, rules: { ...terms, timeZone: 'bad' } })).toMatchObject({ status: 'needs_decision' })
  })
  it('prices the no-show clause separately, in integer minor units, capped to the stay', () => {
    expect(buildNoShowQuote(input)).toMatchObject({ basis: 'NO_SHOW', penaltyMinor: '25000', refundMinor: '75003' })
    expect(buildPenaltyQuote(input)).toMatchObject({ penaltyMinor: '100003' })
    expect(buildNoShowQuote({ ...input, rules: { ...terms, noShow: { penaltyNights: 30 } } })).toMatchObject({ penaltyMinor: '100003', refundMinor: '0' })
  })
  it('missing, malformed, pre-arrival and unknown-length no-show terms require a decision', () => {
    for (const rules of [null, { ...terms, noShow: undefined }, { ...terms, noShow: { penaltyNights: 0 } }]) expect(buildNoShowQuote({ ...input, rules })).toMatchObject({ status: 'needs_decision' })
    expect(buildNoShowQuote({ ...input, requestedAt: new Date('2026-12-01') })).toMatchObject({ status: 'needs_decision' })
    expect(buildNoShowQuote({ ...input, checkOut: undefined, rules: { ...terms, stayNights: undefined } })).toMatchObject({ status: 'needs_decision' })
  })
  it('does not accept browser cancellation overrides on a linked contract', () => {
    for (const override of [{ isRefundable: true }, { cancelDeadline: '2026-12-01' }, { cancellationRules: [{ daysBeforeCheckin: 0, penaltyPercent: 0 }] }]) expect(() => validateManualBooking({ ratePlanId: 'plan', ...override })).toThrow('takes its refundability')
  })
  it('posts a no-show refund once without creating a false cancellation record', () => {
    const event: PostingEvent = { id: 'event', type: 'NO_SHOW', seq: 1, currency: 'AED', sellMinor: 100_003n, netMinor: 80_000n, penaltyMinor: 25_000n, refundMinor: 75_003n, adjustmentMinor: null, paymentMode: 'CREDIT' }
    const facts: PostingFacts = { bookingId: 'booking', agencyId: 'agency', supplierId: 'supplier', walletId: 'wallet', heldMinor: 100_003n, holdReleased: true, chargedMinor: 100_003n, cancellationRefundMinor: null, laterAmendments: [], refundedMinor: 0n, payableMinor: 80_000n, cancelledBefore: false, noShow: true }
    expect(planPosting(event, facts)).toMatchObject({ kind: 'POST', legs: [{ type: 'REFUND', amountMinor: 75_003n }], cancellationRefundMinor: null })
    expect(planPosting(event, { ...facts, refundedMinor: 75_003n })).toMatchObject({ kind: 'SKIP', reason: 'NOTHING_TO_ADD' })
    expect(planPosting({ ...event, penaltyMinor: null, refundMinor: null }, facts)).toMatchObject({ kind: 'SKIP', reason: 'PENALTY_UNDETERMINED' })
    expect(planPosting({ ...event, type: 'PENALTY_WAIVED', penaltyMinor: 0n, refundMinor: 100_003n }, { ...facts, cancelledBefore: true, refundedMinor: 75_003n })).toMatchObject({ kind: 'POST', legs: [{ amountMinor: 25_000n }], cancellationRefundMinor: null })
  })
  it('refuses a cancellation quote made before a concurrent amendment', async () => {
    const updateMany = jest.fn()
    const tx = { booking: { findFirst: jest.fn().mockResolvedValue({ id: 'booking', status: 'CONFIRMED', version: 2, closedAt: null, isRefundable: true }) , updateMany }, bookingEvent: { findUnique: jest.fn().mockResolvedValue(null) } } as unknown as Parameters<typeof transitionBooking>[0]
    await expect(transitionBooking(tx, { tenantId: 'tenant', bookingId: 'booking', action: 'requestCancellation', expectedStatus: 'CONFIRMED', level: 'OPERATOR', actor: { type: 'USER', id: 'user' }, now: new Date(), reason: 'Guest request', penaltyQuote: { ...buildPenaltyQuote(input), bookingVersion: 1 } })).rejects.toThrow('stay changed')
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('a contract-linked manual stay cannot be amended while retaining the old cancellation denominator', async () => {
    const create = jest.fn()
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]), booking: { findFirst: jest.fn().mockResolvedValue({ id: 'booking', version: 1, status: 'CONFIRMED', currency: 'AED', totalMinor: 100_003n, netMinor: null, paymentMode: 'CREDIT', checkIn: new Date('2026-12-10'), checkOut: new Date('2026-12-14'), nights: 4, cancelDeadline: null, searchSnapshot: { source: 'manual' }, cancellationPolicy: terms, rooms: [{ position: 1, adults: 2, children: 0, childAges: [] }] }) }, bookingAmendment: { create } } as unknown as Parameters<typeof recordAmendmentRequest>[0]
    await expect(recordAmendmentRequest(tx, { tenantId: 'tenant', bookingId: 'booking', userId: 'user', raw: { checkOut: '2026-12-15' }, now: new Date('2026-10-01') })).rejects.toThrow('revalidating the contracted stay')
    expect(create).not.toHaveBeenCalled()
  })

})
