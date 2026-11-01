import { isCalendarDay, resolvePlanTerms, type PlanTerms } from './rate-plan-terms'

const none: PlanTerms = { validFrom: null, validTo: null, paymentType: null }
const contract = { validFrom: '2026-01-01', validTo: '2026-12-31' }
const refusal = (input: object, current: PlanTerms = none) => { const r = resolvePlanTerms(input, current, contract); return r.ok ? null : r.code }

describe('rate plan terms', () => {
  it('accepts no terms and records nothing: payment type is never defaulted', () => {
    expect(resolvePlanTerms({}, none, contract)).toEqual({ ok: true, terms: none })
  })
  it('accepts a window and payment type inside the contract term', () => {
    expect(resolvePlanTerms({ validFrom: '2026-03-01', validTo: '2026-06-30', paymentType: 'PREPAID' }, none, contract)).toEqual({ ok: true, terms: { validFrom: '2026-03-01', validTo: '2026-06-30', paymentType: 'PREPAID' } })
  })
  it('keeps a stored value when the key is absent and clears it on an explicit null', () => {
    const current: PlanTerms = { validFrom: '2026-03-01', validTo: '2026-06-30', paymentType: 'PAY_AT_HOTEL' }
    expect(resolvePlanTerms({ paymentType: 'PREPAID' }, current, contract)).toEqual({ ok: true, terms: { ...current, paymentType: 'PREPAID' } })
    expect(resolvePlanTerms({ validTo: null }, current, contract)).toEqual({ ok: true, terms: { ...current, validTo: null } })
  })
  it('refuses a calendar day that would be normalized', () => {
    expect(isCalendarDay('2026-02-30')).toBe(false)
    expect(isCalendarDay('2026-2-3')).toBe(false)
    expect(isCalendarDay(20260301)).toBe(false)
    expect(refusal({ validFrom: '2026-02-30' })).toBe('RATE_PLAN_VALIDITY_INVALID')
    expect(refusal({ validTo: '' })).toBe('RATE_PLAN_VALIDITY_INVALID')
  })
  it('refuses an inverted window', () => { expect(refusal({ validFrom: '2026-06-01', validTo: '2026-05-31' })).toBe('RATE_PLAN_VALIDITY_INVALID') })
  it('never lets the window extend the contract', () => {
    expect(refusal({ validFrom: '2025-12-31' })).toBe('RATE_PLAN_VALIDITY_OUTSIDE_CONTRACT')
    expect(refusal({ validTo: '2027-01-01' })).toBe('RATE_PLAN_VALIDITY_OUTSIDE_CONTRACT')
    expect(refusal({}, { ...none, validTo: '2027-06-01' })).toBe('RATE_PLAN_VALIDITY_OUTSIDE_CONTRACT')
  })
  it('refuses an unknown payment type, including deposit which is not modelled', () => {
    expect(refusal({ paymentType: 'DEPOSIT' })).toBe('RATE_PLAN_PAYMENT_TYPE_INVALID')
    expect(refusal({ paymentType: 'prepaid' })).toBe('RATE_PLAN_PAYMENT_TYPE_INVALID')
  })
})
