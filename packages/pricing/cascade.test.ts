import test from 'node:test'
import assert from 'node:assert/strict'
import { applyMarkupCascade, selectCascadeLayers, convertWithMargin, checkMargin, checkChannelParity, marginBp, FX_RATE_SCALE, type CascadeRule, type CascadeTarget } from './src/index.ts'

const target: CascadeTarget = { supplierId: 's1', hotelId: 'h1', countryCode: 'AE', city: 'Dubai', starRating: 5, chainCode: 'HLT', agencyId: 'a1', agencyTierId: 't1' }

test('layers compound in fixed order with a full trace', () => {
  const r = applyMarkupCascade(10_000n, [
    { layer: 'SUPPLIER_CONTRACT', ruleId: 'r1', adjustment: { kind: 'PERCENT', basisPoints: 1_000 } },
    { layer: 'AGENCY_TIER', ruleId: 'r2', adjustment: { kind: 'FIXED', amountMinor: 250n } },
    { layer: 'CLIENT', ruleId: 'r3', adjustment: { kind: 'PERCENT', basisPoints: 500 } },
  ])
  assert.equal(r.sellMinor, 11_813n) // 10000 -> 11000 -> 11250 -> 11250 + 563 (562.5 half up)
  assert.equal(r.markupMinor, 1_813n)
  assert.deepEqual(r.trace.map((s) => s.afterMinor), [11_000n, 11_250n, 11_813n])
})

test('no layers sells at net; global override can pin the sell price', () => {
  assert.equal(applyMarkupCascade(500n, []).sellMinor, 500n)
  assert.equal(applyMarkupCascade(500n, [{ layer: 'GLOBAL_OVERRIDE', ruleId: 'g', adjustment: { kind: 'SET_SELL', amountMinor: 900n } }]).sellMinor, 900n)
})

test('refuses disorder, repeats, sub-net results and misplaced SET_SELL', () => {
  const pct = (layer: 'SUPPLIER_CONTRACT' | 'CLIENT') => ({ layer, ruleId: layer, adjustment: { kind: 'PERCENT' as const, basisPoints: 100 } })
  assert.throws(() => applyMarkupCascade(100n, [pct('CLIENT'), pct('SUPPLIER_CONTRACT')]), /out of order/)
  assert.throws(() => applyMarkupCascade(100n, [pct('CLIENT'), pct('CLIENT')]), /out of order/)
  assert.throws(() => applyMarkupCascade(100n, [{ layer: 'GLOBAL_OVERRIDE', ruleId: 'g', adjustment: { kind: 'SET_SELL', amountMinor: 99n } }]), /below net/)
  assert.throws(() => applyMarkupCascade(100n, [{ layer: 'CLIENT', ruleId: 'c', adjustment: { kind: 'SET_SELL', amountMinor: 200n } }]), /global override/)
  assert.throws(() => applyMarkupCascade(0n, []), /at least one/)
  assert.throws(() => applyMarkupCascade(100n, [{ layer: 'CLIENT', ruleId: 'c', adjustment: { kind: 'FIXED', amountMinor: -1n } }]), /negative/)
})

test('selection: most specific rule per layer, other layers independent, mismatches skipped', () => {
  const rules: CascadeRule[] = [
    { ruleId: 'broad', layer: 'SUPPLIER_CONTRACT', adjustment: { kind: 'PERCENT', basisPoints: 800 } },
    { ruleId: 'five-star-dubai', layer: 'SUPPLIER_CONTRACT', countryCode: 'AE', starRating: 5, adjustment: { kind: 'PERCENT', basisPoints: 1_200 } },
    { ruleId: 'three-star', layer: 'SUPPLIER_CONTRACT', starRating: 3, adjustment: { kind: 'PERCENT', basisPoints: 100 } },
    { ruleId: 'tier', layer: 'AGENCY_TIER', agencyTierId: 't1', adjustment: { kind: 'FIXED', amountMinor: 100n } },
    { ruleId: 'other-agency', layer: 'CLIENT', agencyId: 'zzz', adjustment: { kind: 'PERCENT', basisPoints: 900 } },
  ]
  assert.deepEqual(selectCascadeLayers(rules, target).map((l) => l.ruleId), ['five-star-dubai', 'tier'])
})

test('selection: equal-specificity clash is an error, not a guess', () => {
  const rules: CascadeRule[] = [
    { ruleId: 'a', layer: 'CLIENT', chainCode: 'HLT', adjustment: { kind: 'PERCENT', basisPoints: 100 } },
    { ruleId: 'b', layer: 'CLIENT', city: 'Dubai', adjustment: { kind: 'PERCENT', basisPoints: 200 } },
  ]
  assert.throws(() => selectCascadeLayers(rules, target), /Ambiguous CLIENT rules: a, b/)
})

const fx = { from: 'USD', to: 'AED', rateScaled: 367_250_000n, bufferBp: 50, volatilityBp: 100, asOfMs: 1_000_000, maxAgeMs: 60_000 }

test('FX applies buffer + volatility against the buyer, per-currency exponents, half up', () => {
  // 100.00 USD * 3.6725 * 1.015 = 372.759... AED -> 37276 fils
  assert.equal(convertWithMargin(10_000n, fx, 1_030_000), 37_276n)
  assert.equal(convertWithMargin(10_000n, { ...fx, bufferBp: 0, volatilityBp: 0 }, 1_030_000), 36_725n)
  assert.equal(convertWithMargin(1_000n, { ...fx, from: 'USD', to: 'JPY', rateScaled: 150n * FX_RATE_SCALE, bufferBp: 0, volatilityBp: 0 }, 1_000_000), 1_500n) // 10.00 USD -> 1500 JPY (0 decimals)
})

test('FX refuses stale, future-dated, oversize-margin and invalid input', () => {
  assert.throws(() => convertWithMargin(1n, fx, 1_060_001), /stale/)
  assert.throws(() => convertWithMargin(1n, fx, 999_999), /future/)
  assert.throws(() => convertWithMargin(1n, { ...fx, bufferBp: 2_000, volatilityBp: 501 }, 1_000_000), /maximum/)
  assert.throws(() => convertWithMargin(1n, { ...fx, volatilityBp: -1 }, 1_000_000), /non-negative/)
  assert.throws(() => convertWithMargin(1n, { ...fx, rateScaled: 0n }, 1_000_000), /positive/)
  assert.throws(() => convertWithMargin(1n, { ...fx, to: 'XXX' }, 1_000_000), /Unsupported currency/)
})

test('margin guard: negative fails, squeeze warns, healthy passes', () => {
  const floor = { minMarginBp: 500, minMarginMinor: 100n }
  assert.equal(marginBp(9_000n, 10_000n), 1_000)
  assert.equal(checkMargin(10_000n, 9_999n, floor)?.code, 'MARGIN_NEGATIVE')
  assert.equal(checkMargin(10_000n, 10_300n, floor)?.code, 'MARGIN_SQUEEZE') // 291bp
  assert.equal(checkMargin(10_000n, 10_050n, { minMarginBp: 0, minMarginMinor: 100n })?.code, 'MARGIN_SQUEEZE')
  assert.equal(checkMargin(10_000n, 11_000n, floor), null)
})

test('parity guard: spread vs the lowest price, tolerance inclusive', () => {
  const prices = [{ channel: 'b2b', sellMinor: 10_000n }, { channel: 'api', sellMinor: 10_300n }, { channel: 'wl', sellMinor: 10_100n }]
  assert.equal(checkChannelParity(prices, 300), null)
  assert.deepEqual(checkChannelParity(prices, 299), { code: 'CHANNEL_PARITY_VIOLATION', severity: 'FAIL', lowestChannel: 'b2b', highestChannel: 'api', spreadBp: 300 })
  assert.equal(checkChannelParity([prices[0]!], 0), null)
  assert.throws(() => checkChannelParity([{ channel: 'x', sellMinor: 0n }, prices[0]!], 10), /positive/)
})

import { fxCorridorPolicy, fxRateFreshness, fxVolatilityOutOfBand, checkParityAgainstBaseline, DEFAULT_MARGIN_POLICY } from './src/index.ts'

test('flat-base percent applies to the original net, not the running amount', () => {
  const layers = (base: 'RUNNING' | 'NET') => [
    { layer: 'SUPPLIER_CONTRACT' as const, ruleId: 'a', adjustment: { kind: 'PERCENT' as const, basisPoints: 1_000 } },
    { layer: 'CLIENT' as const, ruleId: 'b', adjustment: { kind: 'PERCENT' as const, basisPoints: 1_000, base } },
  ]
  assert.equal(applyMarkupCascade(10_000n, layers('RUNNING')).sellMinor, 12_100n)
  assert.equal(applyMarkupCascade(10_000n, layers('NET')).sellMinor, 12_000n)
})

test('margin policy defaults: 8% warns, under 3% blocks', () => {
  const floor = { minMarginBp: DEFAULT_MARGIN_POLICY.warnBelowBp, minMarginMinor: 0n, blockBelowBp: DEFAULT_MARGIN_POLICY.blockBelowBp }
  assert.equal(checkMargin(10_000n, 10_200n, floor)?.code, 'MARGIN_BLOCKED') // 196 bp
  assert.equal(checkMargin(10_000n, 10_600n, floor)?.code, 'MARGIN_SQUEEZE') // 566 bp
  assert.equal(checkMargin(10_000n, 11_000n, floor), null) // 909 bp
})

test('baseline parity needs both the percent and the absolute variation to be exceeded', () => {
  assert.equal(checkParityAgainstBaseline('api', 10_040n, 10_000n, 50, 100n), null) // 40 bp
  assert.equal(checkParityAgainstBaseline('api', 10_080n, 10_000n, 50, 100n), null) // 80 bp but only 0.80 units
  assert.equal(checkParityAgainstBaseline('api', 10_150n, 10_000n, 50, 100n)?.variationBp, 150)
  assert.equal(checkParityAgainstBaseline('api', 9_800n, 10_000n, 50, 100n)?.variationMinor, 200n) // below baseline counts too
})

test('FX corridors: majors 4h, emerging 1h, 12h hard expiry, no cached fallback', () => {
  const major = fxCorridorPolicy('USD', 'AED'); const em = fxCorridorPolicy('INR', 'USD')
  assert.equal(major.corridor, 'STABLE'); assert.equal(em.corridor, 'EMERGING')
  const h = 3_600_000
  assert.equal(fxRateFreshness(major, 0, 4 * h), 'FRESH'); assert.equal(fxRateFreshness(major, 0, 4 * h + 1), 'STALE')
  assert.equal(fxRateFreshness(em, 0, h + 1), 'STALE'); assert.equal(fxRateFreshness(em, 0, 12 * h + 1), 'EXPIRED')
  assert.equal(fxVolatilityOutOfBand(major, 40), null); assert.match(fxVolatilityOutOfBand(major, 120)!, /outside the stable/)
  assert.equal(convertWithMargin(10_000n, { from: 'THB', to: 'AED', rateScaled: 10_000_000n, bufferBp: 0, volatilityBp: 120, asOfMs: 0, maxAgeMs: em.maxAgeMs }, 1_000), 1_012n) // THB now supported
})
