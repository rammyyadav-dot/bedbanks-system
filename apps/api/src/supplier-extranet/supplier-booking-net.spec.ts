import { summariseNet } from './supplier-booking-net'

describe('summariseNet (room-level supplier net, ADR 0061 Amendment 1)', () => {
  it('has nothing to show without room lines or without any recorded net, and never reports zero', () => {
    expect(summariseNet([], null)).toEqual({ netStatus: 'NOT_RECORDED', netMinor: null })
    expect(summariseNet([null, null], 100n)).toEqual({ netStatus: 'NOT_RECORDED', netMinor: null })
  })
  it('does not aggregate when a line is missing', () => {
    expect(summariseNet([100n, null], null)).toEqual({ netStatus: 'PARTIAL', netMinor: null })
  })
  it('sums every line as integers when all are recorded', () => {
    expect(summariseNet([100000n, 250000n], null)).toEqual({ netStatus: 'RECORDED', netMinor: '350000' })
    expect(summariseNet([9007199254740993n, 1n], null)).toEqual({ netStatus: 'RECORDED', netMinor: '9007199254740994' }) // beyond Number.MAX_SAFE_INTEGER
    expect(summariseNet([0n], 0n)).toEqual({ netStatus: 'RECORDED', netMinor: '0' }) // a recorded zero is distinct from "not recorded"
  })
  it('accepts the stored booking net only when it equals the sum, and flags any difference', () => {
    expect(summariseNet([100n, 200n], 300n)).toEqual({ netStatus: 'RECORDED', netMinor: '300' })
    expect(summariseNet([100n, 200n], 299n)).toEqual({ netStatus: 'MISMATCH', netMinor: null })
  })
  it('never treats a negative line as valid', () => {
    expect(summariseNet([100n, -1n], null)).toEqual({ netStatus: 'MISMATCH', netMinor: null })
  })
  it('does not derive a net from the booking-level value alone', () => {
    expect(summariseNet([], 500n)).toEqual({ netStatus: 'NOT_RECORDED', netMinor: null })
  })
})
