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

  describe('simulate() bedbank policy model', () => {
    it('evaluates NIGHTS penalty using actual unequal booked nightly prices', () => {
      const result = service.simulate({
        cancellableAmountMinor: 95000n,
        nightlyAmountsMinor: [25000n, 30000n, 40000n],
        currency: 'AED',
        checkIn: '2026-12-31',
        requestedAt: '2026-12-29T12:00:00.000Z',
        propertyTimeZone: 'Asia/Dubai',
        checkInLocalTime: '15:00',
        rules: [{ daysBeforeCheckin: 3, penaltyType: 'NIGHTS', penaltyNights: 2 }],
      })
      expect(result).toMatchObject({
        status: 'quotable',
        policyResolution: 'RESOLVED',
        selectedPenaltyType: 'NIGHTS',
        penaltyMinor: 55000n,
        refundMinor: 40000n,
        customerCancellationLiabilityMinor: 55000n,
        customerRefundPayableMinor: 40000n,
      })
    })

    it('applies contractual non-refundable liability immediately for NON_REFUNDABLE policy', () => {
      const result = service.simulate({
        cancellableAmountMinor: 42000n,
        currency: 'AED',
        checkIn: '2026-12-31',
        requestedAt: '2026-10-01T00:00:00.000Z',
        policyType: 'NON_REFUNDABLE',
        propertyTimeZone: 'Asia/Dubai',
        rules: [],
      })
      expect(result).toMatchObject({
        status: 'quotable',
        policyType: 'NON_REFUNDABLE',
        policyResolution: 'RESOLVED',
        selectedPenaltyType: 'FULL_AMOUNT',
        freeCancellationDeadlineUtc: null,
        penaltyMinor: 42000n,
        refundMinor: 0n,
        customerRefundPayableMinor: 0n,
      })
    })

    it('never treats missing or conflicting refundable rules as free cancellation', () => {
      const missing = service.simulate({
        cancellableAmountMinor: 42000n,
        currency: 'AED',
        checkIn: '2026-12-31',
        requestedAt: '2026-10-01T00:00:00.000Z',
        policyType: 'REFUNDABLE',
        rules: [],
      })
      expect(missing).toMatchObject({
        status: 'policy_unavailable',
        policyResolution: 'UNRESOLVED',
        reason: 'missing_cancellation_policy',
      })

      const conflicted = service.simulate({
        cancellableAmountMinor: 42000n,
        currency: 'AED',
        checkIn: '2026-12-31',
        requestedAt: '2026-12-30T00:00:00.000Z',
        policyType: 'REFUNDABLE',
        rules: [
          { daysBeforeCheckin: 3, penaltyPercent: 25 },
          { daysBeforeCheckin: 3, penaltyPercent: 75 },
        ],
      })
      expect(conflicted).toMatchObject({
        status: 'manual_review_required',
        policyResolution: 'CONFLICTED',
        reason: 'conflicting_penalty_windows',
      })
    })

    it('separates supplier liability from customer refund and flags supplier penalty discrepancy', () => {
      const result = service.simulate({
        cancellableAmountMinor: 50000n,
        currency: 'AED',
        checkIn: '2026-12-31',
        requestedAt: '2026-12-29T12:00:00.000Z',
        supplierCancellableAmountMinor: 45000n,
        supplierPenaltyOverrideMinor: 40000n,
        rules: [{ daysBeforeCheckin: 3, penaltyPercent: 50 }],
      })
      expect(result).toMatchObject({
        status: 'quotable',
        penaltyMinor: 25000n,
        customerCancellationLiabilityMinor: 25000n,
        customerRefundPayableMinor: 25000n,
        supplierPenaltyMinor: 40000n,
        supplierExpectedCreditMinor: 5000n,
        discrepancyReviewRequired: true,
      })
    })

    it('calculates settlement balance accurately for partial payment and prior partial refunds', () => {
      const partialPaid = service.simulate({
        cancellableAmountMinor: 100000n,
        customerAmountPaidMinor: 30000n,
        retainedFeesMinor: 5000n,
        priorRefundsMinor: 0n,
        currency: 'AED',
        checkIn: '2026-12-31',
        requestedAt: '2026-12-29T12:00:00.000Z',
        rules: [{ daysBeforeCheckin: 3, penaltyPercent: 50 }],
      })
      expect(partialPaid).toMatchObject({
        status: 'quotable',
        customerCancellationLiabilityMinor: 55000n,
        customerRefundEntitlementMinor: 0n,
        customerRefundPayableMinor: 0n,
        settlementBalanceMinor: -25000n,
      })

      const withPriorRefund = service.simulate({
        cancellableAmountMinor: 100000n,
        customerAmountPaidMinor: 100000n,
        retainedFeesMinor: 0n,
        priorRefundsMinor: 60000n,
        currency: 'AED',
        checkIn: '2026-12-31',
        requestedAt: '2026-12-29T12:00:00.000Z',
        rules: [{ daysBeforeCheckin: 3, penaltyPercent: 25 }],
      })
      expect(withPriorRefund).toMatchObject({
        status: 'quotable',
        customerCancellationLiabilityMinor: 25000n,
        customerRefundEntitlementMinor: 15000n,
        customerRefundPayableMinor: 15000n,
        settlementBalanceMinor: 15000n,
      })
    })

    it('distinguishes calendar days at local check-in time vs elapsed hours across a DST boundary', () => {
      // Europe/London switches GMT (UTC+0) -> BST (UTC+1) on 2026-03-29 at 01:00 UTC.
      // Check-in: 2026-03-31 at 18:00 Europe/London = 2026-03-31T17:00:00.000Z.
      // 3 calendar days prior at 18:00 Europe/London (2026-03-28 18:00 GMT) = 2026-03-28T18:00:00.000Z.
      // 72 elapsed hours prior to 2026-03-31T17:00:00.000Z = 2026-03-28T17:00:00.000Z.
      const calendarDays = service.simulate({
        cancellableAmountMinor: 20000n,
        currency: 'GBP',
        checkIn: '2026-03-31',
        checkInLocalTime: '18:00',
        propertyTimeZone: 'Europe/London',
        deadlineSemantics: 'CALENDAR_DAYS_AT_LOCAL_TIME',
        requestedAt: '2026-03-28T17:30:00.000Z',
        rules: [{ daysBeforeCheckin: 3, penaltyPercent: 100 }],
      })
      expect(calendarDays).toMatchObject({
        status: 'quotable',
        freeCancellationDeadlineUtc: '2026-03-28T18:00:00.000Z',
        penaltyMinor: 0n,
      })

      const elapsedHours = service.simulate({
        cancellableAmountMinor: 20000n,
        currency: 'GBP',
        checkIn: '2026-03-31',
        checkInLocalTime: '18:00',
        propertyTimeZone: 'Europe/London',
        deadlineSemantics: 'ELAPSED_HOURS',
        requestedAt: '2026-03-28T17:30:00.000Z',
        rules: [{ elapsedHoursBeforeCheckin: 72, penaltyPercent: 100 }],
      })
      expect(elapsedHours).toMatchObject({
        status: 'quotable',
        freeCancellationDeadlineUtc: '2026-03-28T17:00:00.000Z',
        penaltyMinor: 20000n,
      })
    })
  })

})
