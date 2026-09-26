import { CancellationPolicyService } from './cancellation-policy.service'

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

  it.each([
    [0, 0n], [1, 0n], [5, 2500n], [11, 2500n], [12, 5000n], [17, 5000n],
  ])('applies exact child-age band boundaries for age %s', (age, expected) => {
    expect(service.evaluateCommercialRules({ currency: 'AED', childAges: [age], adults: 2, rooms: 1,
      checkIn: '2026-12-29', checkOut: '2027-01-02',
      childPolicies: [{ minAge: 0, maxAge: 4, supplementMinor: 0n, currency: 'AED' },
        { minAge: 5, maxAge: 11, supplementMinor: 2500n, currency: 'AED' },
        { minAge: 12, maxAge: 17, supplementMinor: 5000n, currency: 'AED' }], supplements: [] }))
      .toMatchObject({ status: 'evaluated', childSupplementMinor: expected })
  })

  it('fails closed for missing and overlapping child bands', () => {
    const input = { currency: 'AED', childAges: [7], adults: 2, rooms: 1, checkIn: '2026-12-29', checkOut: '2027-01-02', supplements: [] }
    expect(service.evaluateCommercialRules({ ...input, childPolicies: [{ minAge: 0, maxAge: 4 }] })).toMatchObject({ status: 'policy_unavailable' })
    expect(service.evaluateCommercialRules({ ...input, childPolicies: [{ minAge: 0, maxAge: 10 }, { minAge: 5, maxAge: 11 }] })).toMatchObject({ status: 'manual_review_required' })
  })

  it('applies a New Years Eve gala exactly once and ignores it outside the stay', () => {
    const common = { currency: 'AED', childAges: [8], adults: 2, rooms: 1,
      childPolicies: [{ minAge: 0, maxAge: 17, supplementMinor: 0n, currency: 'AED' }] }
    const gala = { id: 'nye-2026', kind: 'gala' as const, applicableDate: '2026-12-31', basis: 'per_person' as const, amountMinor: 10000n, currency: 'AED' }
    expect(service.evaluateCommercialRules({ ...common, checkIn: '2026-12-29', checkOut: '2027-01-02', supplements: [gala, gala] }))
      .toMatchObject({ status: 'evaluated', mandatorySupplementMinor: 30000n })
    expect(service.evaluateCommercialRules({ ...common, checkIn: '2027-01-01', checkOut: '2027-01-03', supplements: [gala] }))
      .toMatchObject({ status: 'evaluated', mandatorySupplementMinor: 0n })
  })

  it('supports adult, child, room and once-per-stay mandatory supplement bases', () => {
    const supplements = [
      { id: 'adult', kind: 'mandatory' as const, applicableDate: '2026-12-31', basis: 'per_adult' as const, amountMinor: 100n, currency: 'AED' },
      { id: 'child', kind: 'meal' as const, applicableDate: '2026-12-31', basis: 'per_child' as const, amountMinor: 50n, currency: 'AED' },
      { id: 'room', kind: 'mandatory' as const, applicableDate: '2026-12-31', basis: 'per_room' as const, amountMinor: 200n, currency: 'AED' },
      { id: 'stay', kind: 'mandatory' as const, applicableDate: '2026-12-31', basis: 'once_per_stay' as const, amountMinor: 300n, currency: 'AED' },
    ]
    expect(service.evaluateCommercialRules({ currency: 'AED', childAges: [8, 10], adults: 2, rooms: 2,
      checkIn: '2026-12-29', checkOut: '2027-01-02', childPolicies: [{ minAge: 0, maxAge: 17, supplementMinor: 0n }], supplements }))
      .toMatchObject({ status: 'evaluated', mandatorySupplementMinor: 1000n })
  })

  it('uses Dubai hotel-local midnight as the cancellation deadline authority', () => {
    const input = { cancellableAmountMinor: 10000n, currency: 'AED', checkIn: '2026-12-31',
      propertyTimeZone: 'Asia/Dubai', checkInLocalTime: '00:00', rules: [{ daysBeforeCheckin: 3, penaltyPercent: 100 }] }
    expect(service.quote({ ...input, requestedAt: '2026-12-27T19:59:59.999Z' })).toMatchObject({ status: 'quotable', penaltyMinor: 0n })
    expect(service.quote({ ...input, requestedAt: '2026-12-27T20:00:00.000Z' })).toMatchObject({ status: 'quotable', penaltyMinor: 10000n })
    expect(service.quote({ ...input, requestedAt: '2026-12-27T20:00:00.001Z' })).toMatchObject({ status: 'quotable', penaltyMinor: 10000n })
  })

  it('uses Kolkata local time and handles year rollover deterministically', () => {
    expect(service.quote({ cancellableAmountMinor: 10000n, currency: 'INR', checkIn: '2027-01-01',
      propertyTimeZone: 'Asia/Kolkata', checkInLocalTime: '00:00', requestedAt: '2026-12-28T18:30:00.000Z',
      rules: [{ daysBeforeCheckin: 3, penaltyPercent: 50 }] })).toMatchObject({ status: 'quotable', penaltyMinor: 5000n })
  })

  it('fails closed for invalid IANA timezone', () => {
    expect(service.quote({ ...base, propertyTimeZone: 'Mars/Dubai', rules: [{ daysBeforeCheckin: 3, penaltyPercent: 100 }] }))
      .toMatchObject({ status: 'manual_review_required' })
  })

})
