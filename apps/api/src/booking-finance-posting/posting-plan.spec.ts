import { agencyEffect, planPosting, type PostingEvent, type PostingFacts } from './posting-plan'

const B = 'bk1'
const event = (over: Partial<PostingEvent> = {}): PostingEvent => ({ id: 'e1', type: 'CONFIRMED', seq: 1, currency: 'AED', sellMinor: 100_000n, netMinor: 80_000n, penaltyMinor: null, refundMinor: null, adjustmentMinor: null, paymentMode: 'CREDIT', ...over })
const facts = (over: Partial<PostingFacts> = {}): PostingFacts => ({
  bookingId: B, agencyId: 'ag1', supplierId: 'sup1', walletId: 'w1', heldMinor: null, holdReleased: false, chargedMinor: null, refundedMinor: 0n, payableMinor: 0n,
  cancellationRefundMinor: null, laterAmendments: [], cancelledBefore: false, ...over,
})
const post = (e: PostingEvent, f: PostingFacts) => { const plan = planPosting(e, f); if (plan.kind !== 'POST') throw new Error(`expected POST, got ${JSON.stringify(plan, (_k, v) => typeof v === 'bigint' ? v.toString() : v)}`); return plan }
const legs = (e: PostingEvent, f: PostingFacts) => post(e, f).legs.map((l) => [l.type, l.amountMinor, l.idempotencyKey] as const)
const K = `booking:${B}:authorize`

describe('booking finance posting rules (ADR 0076)', () => {
  describe('gates', () => {
    it('an unknown payment mode is reviewed, never guessed', () => expect(planPosting(event({ paymentMode: null }), facts())).toEqual({ kind: 'REVIEW', reason: 'PAYMENT_MODE_UNKNOWN' }))
    it('pay at hotel moves no money through us: no charge, no payable', () => {
      for (const type of ['CONFIRMED', 'ON_REQUEST_HOLD', 'HOLD_RELEASED', 'CANCELLED', 'AMENDED'] as const) expect(planPosting(event({ type, paymentMode: 'PAY_AT_HOTEL' }), facts())).toEqual({ kind: 'SKIP', reason: 'PAY_AT_HOTEL' })
    })
    it('a booking with no agency cannot be charged', () => expect(planPosting(event(), facts({ agencyId: null }))).toEqual({ kind: 'REVIEW', reason: 'NO_AGENCY' }))
    it('an agency with no open account is reviewed: an account is never opened here', () => expect(planPosting(event(), facts({ walletId: null }))).toEqual({ kind: 'REVIEW', reason: 'NO_WALLET' }))
  })

  describe('CONFIRMED', () => {
    it('a direct confirmation posts the Agent lifecycle (hold, release, debit) so the integrity monitor ties out, and accrues the net payable', () => {
      const plan = post(event(), facts())
      expect(plan.legs).toEqual([
        { type: 'HOLD', amountMinor: -100_000n, reference: `booking:${B}`, idempotencyKey: K },
        { type: 'RELEASE', amountMinor: 100_000n, reference: `booking:${B}`, idempotencyKey: `${K}:settle-release` },
        { type: 'DEBIT', amountMinor: -100_000n, reference: `booking:${B}`, idempotencyKey: `${K}:settle-debit` },
      ])
      expect(plan.payable).toEqual({ kind: 'ACCRUAL', amountMinor: 80_000n })
      expect(agencyEffect(plan.legs)).toBe(-100_000n)
    })
    it('converts an open on-request hold: release it, then debit; this event nets to zero because the hold already lowered the balance', () => {
      expect(legs(event(), facts({ heldMinor: 100_000n }))).toEqual([['RELEASE', 100_000n, `${K}:settle-release`], ['DEBIT', -100_000n, `${K}:settle-debit`]])
      expect(agencyEffect(post(event(), facts({ heldMinor: 100_000n })).legs)).toBe(0n)
    })
    it('a hold that was already released by a plain release is not converted twice: it is held again for the settlement', () => {
      expect(legs(event(), facts({ heldMinor: 100_000n, holdReleased: true }))).toEqual([['DEBIT', -100_000n, `${K}:settle-debit`]])
    })
    it('a hold taken for another amount is reviewed, not converted', () => expect(planPosting(event({ sellMinor: 90_000n }), facts({ heldMinor: 100_000n }))).toEqual({ kind: 'REVIEW', reason: 'HOLD_AMOUNT_DIFFERS' }))
    it('never charges twice: a booking the Agent flow already charged is skipped', () => expect(planPosting(event(), facts({ chargedMinor: 100_000n }))).toEqual({ kind: 'SKIP', reason: 'ALREADY_CHARGED_ON_LEDGER' }))
    it('an amendment recorded before the confirmation posted is folded in: the booking is charged its current totals once', () => {
      const plan = post(event(), facts({ laterAmendments: [{ sellMinor: 110_000n, netMinor: 88_000n }, { sellMinor: 120_000n, netMinor: 95_000n }] }))
      expect(plan.legs.map((l) => l.amountMinor)).toEqual([-120_000n, 120_000n, -120_000n])
      expect(plan.payable).toEqual({ kind: 'ACCRUAL', amountMinor: 95_000n })
      expect(plan.notes).toContain('INCLUDES_LATER_AMENDMENT')
    })
    it('an unknown net is reviewed with nothing posted: the payable cannot be guessed as zero', () => expect(planPosting(event({ netMinor: null }), facts())).toEqual({ kind: 'REVIEW', reason: 'NET_UNKNOWN' }))
    it('a positive net needs a supplier to accrue to', () => expect(planPosting(event(), facts({ supplierId: null }))).toEqual({ kind: 'REVIEW', reason: 'NO_SUPPLIER' }))
    it('a zero net accrues nothing and needs no supplier', () => {
      const plan = post(event({ netMinor: 0n }), facts({ supplierId: null }))
      expect(plan.payable).toBeNull()
      expect(plan.legs).toHaveLength(3)
    })
    it('a zero sell with a zero net moves nothing', () => expect(planPosting(event({ sellMinor: 0n, netMinor: 0n }), facts())).toEqual({ kind: 'SKIP', reason: 'ZERO_SELL' }))
  })

  describe('on-request hold', () => {
    const hold = event({ type: 'ON_REQUEST_HOLD', netMinor: null })
    it('holds the sell price on the Agent flow key and accrues nothing', () => {
      const plan = post(hold, facts())
      expect(plan.legs).toEqual([{ type: 'HOLD', amountMinor: -100_000n, reference: `booking:${B}`, idempotencyKey: K }])
      expect(plan.payable).toBeNull()
    })
    it('is skipped when the hold already exists', () => expect(planPosting(hold, facts({ heldMinor: 100_000n }))).toEqual({ kind: 'SKIP', reason: 'HOLD_ALREADY_POSTED' }))
    it('needs an open account', () => expect(planPosting(hold, facts({ walletId: null }))).toEqual({ kind: 'REVIEW', reason: 'NO_WALLET' }))
    it('releases the held amount once, on the Agent flow release key', () => {
      const release = event({ type: 'HOLD_RELEASED', netMinor: null })
      expect(legs(release, facts({ heldMinor: 100_000n }))).toEqual([['RELEASE', 100_000n, `${K}:release`]])
      expect(planPosting(release, facts({ heldMinor: 100_000n, holdReleased: true }))).toEqual({ kind: 'SKIP', reason: 'HOLD_ALREADY_RELEASED' })
      expect(planPosting(release, facts())).toEqual({ kind: 'SKIP', reason: 'NO_HOLD_ON_LEDGER' })
    })
  })

  describe('cancellation', () => {
    const cancelled = (over: Partial<PostingEvent> = {}) => event({ type: 'CANCELLED', penaltyMinor: 20_000n, refundMinor: 80_000n, ...over })
    const charged = (over: Partial<PostingFacts> = {}) => facts({ chargedMinor: 100_000n, payableMinor: 80_000n, ...over })

    it('refunds sell minus penalty on the Agent flow key and fixes the Cancellation record to that refund', () => {
      const plan = post(cancelled(), charged())
      expect(plan.legs).toEqual([{ type: 'REFUND', amountMinor: 80_000n, reference: `booking:${B}`, idempotencyKey: `booking:${B}:cancel-refund` }])
      expect(plan.cancellationRefundMinor).toBe(80_000n)
    })
    it('keeps the supplier accrual when there is a penalty: the supplier may charge its own fee', () => {
      const plan = post(cancelled(), charged())
      expect(plan.payable).toBeNull()
      expect(plan.notes).toContain('SUPPLIER_LEG_AWAITS_STATEMENT')
    })
    it('reverses the whole accrual when the cancellation is penalty-free', () => {
      const plan = post(cancelled({ penaltyMinor: 0n, refundMinor: 100_000n }), charged())
      expect(plan.legs.map((l) => l.amountMinor)).toEqual([100_000n])
      expect(plan.payable).toEqual({ kind: 'REVERSAL', amountMinor: -80_000n })
    })
    it('a full penalty refunds nothing but still writes the Cancellation record (refund zero), which the monitor requires', () => {
      const plan = post(cancelled({ penaltyMinor: 100_000n, refundMinor: 0n }), charged())
      expect(plan.legs).toEqual([])
      expect(plan.cancellationRefundMinor).toBe(0n)
    })
    it('an undetermined penalty posts nothing: money is never guessed', () => expect(planPosting(cancelled({ penaltyMinor: null, refundMinor: null }), charged())).toEqual({ kind: 'SKIP', reason: 'PENALTY_UNDETERMINED' }))
    it('a decision after an undetermined cancellation posts the refund', () => {
      const decided = event({ type: 'PENALTY_DECIDED', penaltyMinor: 30_000n, refundMinor: 70_000n })
      expect(legs(decided, charged({ cancelledBefore: true }))).toEqual([['REFUND', 70_000n, `booking:${B}:cancel-refund`]])
    })
    it('a decision before the cancellation completes waits for it', () => {
      expect(planPosting(event({ type: 'PENALTY_DECIDED', penaltyMinor: 30_000n, refundMinor: 70_000n }), charged())).toEqual({ kind: 'SKIP', reason: 'AWAITS_CANCELLATION' })
    })
    it('a waiver tops the refund up by the difference, on a key that names the new total, and moves the Cancellation record with it', () => {
      const waived = event({ type: 'PENALTY_WAIVED', penaltyMinor: 5_000n, refundMinor: 95_000n })
      const plan = post(waived, charged({ cancelledBefore: true, refundedMinor: 80_000n, cancellationRefundMinor: 80_000n }))
      expect(plan.legs).toEqual([{ type: 'REFUND', amountMinor: 15_000n, reference: `booking:${B}`, idempotencyKey: `booking:${B}:cancel-refund:95000` }])
      expect(plan.cancellationRefundMinor).toBe(95_000n)
    })
    it('a decision that would refund less than already refunded needs a person: a refund is never taken back', () => {
      const decided = event({ type: 'PENALTY_DECIDED', penaltyMinor: 50_000n, refundMinor: 50_000n })
      expect(planPosting(decided, charged({ cancelledBefore: true, refundedMinor: 80_000n }))).toEqual({ kind: 'REVIEW', reason: 'REFUND_WOULD_DECREASE' })
    })
    it('nothing to add when the refund and the record are already in place', () => {
      expect(planPosting(cancelled(), charged({ refundedMinor: 80_000n, cancellationRefundMinor: 80_000n }))).toEqual({ kind: 'SKIP', reason: 'NOTHING_TO_ADD' })
    })
    it('a refund posted by the API-side settlement without this record yet only completes the record', () => {
      const plan = post(cancelled(), charged({ refundedMinor: 80_000n, cancellationRefundMinor: null }))
      expect(plan.legs).toEqual([])
      expect(plan.cancellationRefundMinor).toBe(80_000n)
    })
    it('a refund above what was charged is reviewed', () => {
      expect(planPosting(cancelled({ sellMinor: 150_000n, penaltyMinor: 0n, refundMinor: 150_000n }), charged())).toEqual({ kind: 'REVIEW', reason: 'REFUND_EXCEEDS_CHARGE' })
    })
    it('an event whose penalty and refund do not add up to the sell is reviewed', () => {
      expect(planPosting(cancelled({ refundMinor: 79_999n }), charged())).toEqual({ kind: 'REVIEW', reason: 'EVENT_INCONSISTENT' })
    })
    it('a booking never charged on the ledger has nothing to refund', () => expect(planPosting(cancelled(), facts())).toEqual({ kind: 'SKIP', reason: 'NOT_CHARGED_ON_LEDGER' }))
    it('a penalty-free cancel of an uncharged booking still reverses a payable that exists', () => {
      const plan = post(cancelled({ penaltyMinor: 0n, refundMinor: 100_000n }), facts({ payableMinor: 80_000n }))
      expect(plan.legs).toEqual([])
      expect(plan.payable).toEqual({ kind: 'REVERSAL', amountMinor: -80_000n })
    })
  })

  describe('amendment', () => {
    const amended = (over: Partial<PostingEvent> = {}) => event({ type: 'AMENDED', seq: 2, sellMinor: 120_000n, netMinor: 95_000n, adjustmentMinor: 20_000n, ...over })

    it('is never a separate ledger entry: one charge per booking, tied to the booking total by the integrity monitor', () => {
      expect(planPosting(amended(), facts({ chargedMinor: 120_000n }))).toEqual({ kind: 'SKIP', reason: 'AMENDMENT_ALREADY_REFLECTED' })
    })
    it('an earlier amendment is reflected when the charge already equals a later total', () => {
      expect(planPosting(amended({ sellMinor: 110_000n }), facts({ chargedMinor: 120_000n, laterAmendments: [{ sellMinor: 120_000n, netMinor: 95_000n }] }))).toEqual({ kind: 'SKIP', reason: 'AMENDMENT_ALREADY_REFLECTED' })
    })
    it('an amendment of a booking that was already charged at another total needs a Finance decision, and posts nothing', () => {
      expect(planPosting(amended(), facts({ chargedMinor: 100_000n }))).toEqual({ kind: 'REVIEW', reason: 'AMENDMENT_NEEDS_LEDGER_ADJUSTMENT' })
      expect(planPosting(amended({ adjustmentMinor: -10_000n, sellMinor: 90_000n }), facts({ chargedMinor: 100_000n }))).toEqual({ kind: 'REVIEW', reason: 'AMENDMENT_NEEDS_LEDGER_ADJUSTMENT' })
    })
    it('an amendment of a booking never charged is skipped', () => expect(planPosting(amended(), facts())).toEqual({ kind: 'SKIP', reason: 'NOT_CHARGED_ON_LEDGER' }))
    it('a zero adjustment is not a money fact and is inconsistent', () => expect(planPosting(amended({ adjustmentMinor: 0n }), facts({ chargedMinor: 100_000n }))).toEqual({ kind: 'REVIEW', reason: 'EVENT_INCONSISTENT' }))
  })

  it('every ledger amount carries the sign its kind requires (ADR 0062)', () => {
    const plans = [post(event(), facts()), post(event({ type: 'ON_REQUEST_HOLD' }), facts()), post(event({ type: 'CANCELLED', penaltyMinor: 0n, refundMinor: 100_000n }), facts({ chargedMinor: 100_000n }))]
    for (const leg of plans.flatMap((p) => p.legs)) expect(leg.amountMinor !== 0n && (leg.type === 'DEBIT' || leg.type === 'HOLD' ? leg.amountMinor < 0n : leg.amountMinor > 0n)).toBe(true)
  })

  it('a booking posted by these rules satisfies the integrity monitor\'s lifecycle: settle-release equals the charge and the hold equals the total', () => {
    const lifecycle = post(event(), facts()).legs
    const sum = (type: string) => lifecycle.filter((l) => l.type === type).reduce((n, l) => n + (l.amountMinor < 0n ? -l.amountMinor : l.amountMinor), 0n)
    expect(sum('RELEASE')).toBe(sum('DEBIT'))
    expect(sum('HOLD')).toBe(100_000n)
    expect(lifecycle.every((l) => l.reference === `booking:${B}`)).toBe(true)
  })
})
