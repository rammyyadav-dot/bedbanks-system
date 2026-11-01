import { offerPaymentType } from './offer-payment-type'

describe('offer payment type', () => {
  it('maps recorded values', () => {
    expect(offerPaymentType('PREPAID')).toBe('prepaid')
    expect(offerPaymentType('PAY_AT_HOTEL')).toBe('pay_at_hotel')
  })
  it('never invents prepaid when nothing is recorded or the value is unknown', () => {
    expect(offerPaymentType(null)).toBe('unspecified')
    expect(offerPaymentType(undefined)).toBe('unspecified')
    expect(offerPaymentType('DEPOSIT')).toBe('unspecified')
  })
})
