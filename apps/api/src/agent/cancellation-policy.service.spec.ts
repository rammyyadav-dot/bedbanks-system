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

  it('states a free-cancellation deadline only when a penalty rule is unambiguous', () => {
    const deadline = service.freeCancellationDeadline({
      refundable: true, checkIn: '2026-10-12', timeZone: 'Asia/Dubai', rules: [{ daysBeforeCheckin: 3, penaltyPercent: 100 }],
    })
    expect(deadline).toBe('2026-10-08T20:00:00.000Z')
    expect(service.freeCancellationDeadline({ refundable: false, checkIn: '2026-10-12', timeZone: 'Asia/Dubai', rules: [{ daysBeforeCheckin: 3, penaltyPercent: 100 }] })).toBeUndefined()
    expect(service.freeCancellationDeadline({ refundable: true, checkIn: '2026-10-12', timeZone: 'Asia/Dubai', rules: [] })).toBeUndefined()
    expect(service.freeCancellationDeadline({ refundable: true, checkIn: '2026-10-12', timeZone: 'Asia/Dubai', rules: [{ daysBeforeCheckin: 3, penaltyPercent: 50, penaltyMinor: 1n }] })).toBeUndefined()
  })

})
