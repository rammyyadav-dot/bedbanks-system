import { supplierMutationAcceptedReference, supplierMutationFingerprint } from './supplier-mutation-journal.service'

describe('supplier mutation fingerprint', () => {
  const base = {
    offerId: 'offer-a', searchId: 'search-a', holdId: 'hold-a', checkIn: '2099-01-01', checkOut: '2099-01-03',
    rooms: 1, adults: 2, children: 0, currency: 'AED', totalMinor: 6000,
  }

  it('is stable and does not include guest identity', () => {
    expect(supplierMutationFingerprint(base)).toBe(supplierMutationFingerprint({ ...base }))
    expect(supplierMutationFingerprint(base)).toMatch(/^[a-f0-9]{64}$/)
    expect(supplierMutationFingerprint(base)).not.toContain('Guest')
  })

  it('changes when the commercial identity changes', () => {
    expect(supplierMutationFingerprint({ ...base, totalMinor: 6001 })).not.toBe(supplierMutationFingerprint(base))
  })

  it('accepts only acknowledged or resolved success references', () => {
    expect(supplierMutationAcceptedReference({ status: 'PREPARED', supplierStatus: null, supplierReference: null })).toBeNull()
    expect(supplierMutationAcceptedReference({ status: 'SENDING', supplierStatus: null, supplierReference: 'ref' })).toBeNull()
    expect(supplierMutationAcceptedReference({ status: 'UNKNOWN', supplierStatus: null, supplierReference: 'ref' })).toBeNull()
    expect(supplierMutationAcceptedReference({ status: 'REJECTED', supplierStatus: 'rejected', supplierReference: null })).toBeNull()
    expect(supplierMutationAcceptedReference({ status: 'ACKNOWLEDGED', supplierStatus: 'accepted', supplierReference: 'ref-a' })).toBe('ref-a')
    expect(supplierMutationAcceptedReference({ status: 'RESOLVED', supplierStatus: 'accepted', supplierReference: 'ref-a' })).toBe('ref-a')
    expect(supplierMutationAcceptedReference({ status: 'RESOLVED', supplierStatus: 'not_sent', supplierReference: null })).toBeNull()
  })
})
