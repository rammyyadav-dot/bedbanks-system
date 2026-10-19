import { convertMinor, effectiveRateDecimal, parseRate } from './fx'

describe('controlled FX (ADR 0067, F-12)', () => {
  const usdToAed = { from: 'USD', to: 'AED', rateScaled: parseRate('3.6725')!, bufferBp: 0 }
  it('converts minor units exactly, rounding half up once', () => {
    expect(convertMinor(10_000n, usdToAed)).toBe(36_725n) // USD 100.00 -> AED 367.25
    expect(convertMinor(1n, usdToAed)).toBe(4n) // 0.036725 AED rounds to 0.04
  })
  it('adds the buffer on top of the rate', () => {
    expect(convertMinor(10_000n, { ...usdToAed, bufferBp: 200 })).toBe(37_460n) // 367.25 * 1.02 = 374.595 -> 374.60
  })
  it('respects each currency\'s minor digits', () => {
    const aedToKwd = { from: 'AED', to: 'KWD', rateScaled: parseRate('0.0836')!, bufferBp: 0 }
    expect(convertMinor(100_000n, aedToKwd)).toBe(83_600n) // AED 1000.00 -> KWD 83.600 (3 digits)
    const aedToJpy = { from: 'AED', to: 'JPY', rateScaled: parseRate('40.5')!, bufferBp: 0 }
    expect(convertMinor(10_050n, aedToJpy)).toBe(4_070n) // AED 100.50 -> JPY 4070.25 -> 4070 (0 digits)
  })
  it('parses and freezes rates as decimals without floats', () => {
    expect(parseRate('3.6725')).toBe(367_250_000n); expect(parseRate('0')).toBeNull(); expect(parseRate('1.123456789')).toBeNull(); expect(parseRate('-1')).toBeNull()
    expect(effectiveRateDecimal({ rateScaled: 367_250_000n, bufferBp: 200 })).toBe('3.74595000')
  })
})
