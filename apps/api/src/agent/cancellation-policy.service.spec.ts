import { CancellationPolicyService, buyerRules, describePenalty, nightsPenalty, penaltyStartsAt } from './cancellation-policy.service'

describe('CancellationPolicyService', () => {
  const service = new CancellationPolicyService()
  const base = { cancellableAmountMinor: 10001n, currency: 'AED', checkIn: '2026-12-31', requestedAt: '2026-12-29T00:00:00.000Z' }

  it('quotes free cancellation when no penalty window applies', () => {
    expect(service.quote({ ...base, requestedAt: '2026-12-20T00:00:00.000Z', rules: [{ daysBeforeCheckin: 3, penaltyPercent: 100 }] }))
      .toMatchObject({ status: 'quotable', penaltyMinor: 0n, refundMinor: 10001n })
  })

  it.each([[25, 2500n, 7501n], [50, 5000n, 5001n], [100, 10001n, 0n]])('uses integer minor units for %s%% penalty', (penaltyPercent, penaltyMinor, refundMinor) => {
    expect(service.quote({ ...base, rules: [{ daysBeforeCheckin: 3, penaltyPercent }] }))
      .toMatchObject({ status: 'quotable', penaltyMinor, refundMinor })
  })

  it('applies the penalty exactly at the deadline', () => {
    expect(service.quote({ ...base, requestedAt: '2026-12-28T00:00:00.000Z', rules: [{ daysBeforeCheckin: 3, penaltyPercent: 100 }] }))
      .toMatchObject({ status: 'quotable', penaltyMinor: 10001n, refundMinor: 0n })
  })

  it('does not apply the penalty one millisecond before the deadline', () => {
    expect(service.quote({ ...base, requestedAt: '2026-12-27T23:59:59.999Z', rules: [{ daysBeforeCheckin: 3, penaltyPercent: 100 }] }))
      .toMatchObject({ status: 'quotable', penaltyMinor: 0n, refundMinor: 10001n })
  })

  it('caps a fixed penalty at the cancellable amount', () => {
    expect(service.quote({ ...base, rules: [{ daysBeforeCheckin: 3, penaltyMinor: 50000n, currency: 'AED' }] }))
      .toMatchObject({ status: 'quotable', penaltyMinor: 10001n, refundMinor: 0n })
  })

  it('fails closed for missing, ambiguous and currency-mismatched rules', () => {
    expect(service.quote({ ...base, rules: [] })).toMatchObject({ status: 'policy_unavailable' })
    expect(service.quote({ ...base, rules: [{ daysBeforeCheckin: 3, penaltyPercent: 50, penaltyMinor: 5000n }] })).toMatchObject({ status: 'manual_review_required' })
    expect(service.quote({ ...base, rules: [{ daysBeforeCheckin: 3, penaltyMinor: 5000n, currency: 'USD' }] })).toMatchObject({ status: 'manual_review_required' })
  })

  it('preserves refund + penalty = cancellable amount', () => {
    for (const amount of [0n, 1n, 99n, 100n, 10001n]) for (const percent of [0, 1, 25, 50, 99, 100]) {
      const quote = service.quote({ ...base, cancellableAmountMinor: amount, rules: [{ daysBeforeCheckin: 3, penaltyPercent: percent }] })
      expect(quote.status).toBe('quotable')
      if (quote.status === 'quotable') expect(quote.refundMinor + quote.penaltyMinor).toBe(amount)
    }
  })

  it('uses Dubai hotel-local midnight as the cancellation deadline authority', () => {
    const input = { cancellableAmountMinor: 10000n, currency: 'AED', checkIn: '2026-12-31',
      propertyTimeZone: 'Asia/Dubai', rules: [{ daysBeforeCheckin: 3, penaltyPercent: 100 }] }
    expect(service.quote({ ...input, requestedAt: '2026-12-27T19:59:59.999Z' })).toMatchObject({ status: 'quotable', penaltyMinor: 0n })
    expect(service.quote({ ...input, requestedAt: '2026-12-27T20:00:00.000Z' })).toMatchObject({ status: 'quotable', penaltyMinor: 10000n })
    expect(service.quote({ ...input, requestedAt: '2026-12-27T20:00:00.001Z' })).toMatchObject({ status: 'quotable', penaltyMinor: 10000n })
  })

  it('uses Kolkata local time and handles year rollover deterministically', () => {
    expect(service.quote({ cancellableAmountMinor: 10000n, currency: 'INR', checkIn: '2027-01-01',
      propertyTimeZone: 'Asia/Kolkata', requestedAt: '2026-12-28T18:30:00.000Z',
      rules: [{ daysBeforeCheckin: 3, penaltyPercent: 50 }] })).toMatchObject({ status: 'quotable', penaltyMinor: 5000n })
  })

  it('fails closed for invalid IANA timezone', () => {
    expect(service.quote({ ...base, propertyTimeZone: 'Mars/Dubai', rules: [{ daysBeforeCheckin: 3, penaltyPercent: 100 }] }))
      .toMatchObject({ status: 'manual_review_required' })
  })

  it('states a free-cancellation deadline only when a penalty rule is unambiguous', () => {
    const deadline = service.freeCancellationDeadline({
      refundable: true, checkIn: '2026-10-12', timeZone: 'Asia/Dubai', rules: [{ daysBeforeCheckin: 3, penaltyPercent: 100 }],
    })
    expect(deadline).toBe('2026-10-08T20:00:00.000Z')
    expect(service.freeCancellationDeadline({ refundable: false, checkIn: '2026-10-12', timeZone: 'Asia/Dubai', rules: [{ daysBeforeCheckin: 3, penaltyPercent: 100 }] })).toBeUndefined()
    expect(service.freeCancellationDeadline({ refundable: true, checkIn: '2026-10-12', timeZone: 'Asia/Dubai', rules: [] })).toBeUndefined()
    expect(service.freeCancellationDeadline({ refundable: true, checkIn: '2026-10-12', timeZone: 'Asia/Dubai', rules: [{ daysBeforeCheckin: 3, penaltyPercent: 50, penaltyMinor: 1n }] })).toBeUndefined()
  })

  describe('nights, buffer and one deadline instant (ADR 0067, F-10)', () => {
    it('charges a nights penalty pro rata of the stay, rounded down and capped at the stay', () => {
      expect(nightsPenalty(10001n, 1, 3)).toBe(3333n)
      expect(nightsPenalty(10001n, 5, 3)).toBe(10001n)
      expect(service.quote({ ...base, stayNights: 4, rules: [{ daysBeforeCheckin: 3, penaltyNights: 1 }] })).toMatchObject({ status: 'quotable', penaltyMinor: 2500n, refundMinor: 7501n })
    })
    it('never treats a nights rule as free when the stay length is unknown, or a rule with two forms as valid', () => {
      expect(service.quote({ ...base, rules: [{ daysBeforeCheckin: 3, penaltyNights: 1 }] })).toMatchObject({ status: 'manual_review_required', reason: 'stay_nights_unknown' })
      expect(service.quote({ ...base, stayNights: 2, rules: [{ daysBeforeCheckin: 3, penaltyNights: 1, penaltyPercent: 10 }] })).toMatchObject({ status: 'manual_review_required', reason: 'ambiguous_penalty_rule' })
    })
    it('the offer deadline and the quote switch at the same hotel-local instant', () => {
      const rules = [{ daysBeforeCheckin: 2, penaltyNights: 1 }]
      const deadline = service.freeCancellationDeadline({ refundable: true, checkIn: '2026-12-31', timeZone: 'Asia/Dubai', rules })!
      expect(deadline).toBe('2026-12-28T20:00:00.000Z')
      expect(new Date(penaltyStartsAt('2026-12-31', 2, 'Asia/Dubai')!).toISOString()).toBe(deadline)
      const at = (ms: number) => service.quote({ ...base, propertyTimeZone: 'Asia/Dubai', stayNights: 2, requestedAt: new Date(Date.parse(deadline) + ms).toISOString(), rules })
      expect(at(-1)).toMatchObject({ penaltyMinor: 0n }); expect(at(0)).toMatchObject({ penaltyMinor: 5000n })
    })
    it('a client buffer starts every tier earlier for the buyer', () => {
      expect(buyerRules([{ daysBeforeCheckin: 3, penaltyPercent: 50 }, { daysBeforeCheckin: 0, penaltyPercent: 100 }], 2)).toEqual([{ daysBeforeCheckin: 5, penaltyPercent: 50 }, { daysBeforeCheckin: 2, penaltyPercent: 100 }])
      expect(service.freeCancellationDeadline({ refundable: true, checkIn: '2026-10-12', timeZone: 'Asia/Dubai', rules: buyerRules([{ daysBeforeCheckin: 3, penaltyPercent: 100 }], 2) })).toBe('2026-10-06T20:00:00.000Z')
    })
    it('describes each penalty form for documents', () => {
      expect(describePenalty({ penaltyNights: 1 }, String)).toBe('1 night (pro rata of the booking total)')
      expect(describePenalty({ penaltyPercent: 50 }, String)).toBe('50% of the booking total')
      expect(describePenalty({ penaltyMinor: 1200n }, (m) => `AED ${m}`)).toBe('AED 1200')
    })
  })

  describe('penaltySchedule', () => {
    const rules = [{ daysBeforeCheckin: 7, penaltyPercent: 50 }, { daysBeforeCheckin: 2, penaltyPercent: 100 }]
    const input = { cancellableAmountMinor: 10001n, currency: 'AED', checkIn: '2026-12-31', propertyTimeZone: 'Asia/Dubai', rules }

    it('lists free, then 50% from 7 days, then 100% from 2 days before check-in, each at hotel-local midnight', () => {
      const tiers = service.penaltySchedule(input)!
      expect(tiers.map((t) => [t.startsAt, t.penaltyMinor, t.refundMinor])).toEqual([
        [null, 0n, 10001n],
        ['2026-12-23T20:00:00.000Z', 5000n, 5001n],
        ['2026-12-28T20:00:00.000Z', 10001n, 0n],
      ])
    })

    it('agrees with a quote taken at each tier start and one millisecond before it', () => {
      const tiers = service.penaltySchedule(input)!
      for (const tier of tiers.filter((t) => t.startsAt)) {
        const at = service.quote({ ...input, requestedAt: tier.startsAt! })
        expect(at).toMatchObject({ penaltyMinor: tier.penaltyMinor })
        const before = service.quote({ ...input, requestedAt: new Date(Date.parse(tier.startsAt!) - 1).toISOString() })
        expect(before).toMatchObject({ status: 'quotable' })
        expect((before as { penaltyMinor: bigint }).penaltyMinor < tier.penaltyMinor).toBe(true)
      }
    })

    it('has no free lead-in when the earliest tier is itself free, and every tier keeps penalty + refund = amount', () => {
      const tiers = service.penaltySchedule({ ...input, rules: [{ daysBeforeCheckin: 14, penaltyPercent: 0 }, ...rules] })!
      expect(tiers[0]).toMatchObject({ penaltyMinor: 0n })
      expect(tiers).toHaveLength(3)
      expect(tiers.every((t) => t.penaltyMinor + t.refundMinor === 10001n)).toBe(true)
    })

    it('fails closed instead of returning a partial schedule', () => {
      expect(service.penaltySchedule({ ...input, rules: [] })).toBeUndefined()
      expect(service.penaltySchedule({ ...input, rules: [{ daysBeforeCheckin: 3, penaltyPercent: 101 }] })).toBeUndefined()
      expect(service.penaltySchedule({ ...input, rules: [{ daysBeforeCheckin: 3, penaltyNights: 1 }] })).toBeUndefined() // stay length unknown
      expect(service.penaltySchedule({ ...input, propertyTimeZone: 'Not/AZone' })).toBeUndefined()
    })
  })
})
