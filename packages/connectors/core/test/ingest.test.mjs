import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractJsonRecords, extractXmlRecords, normalizeRates, normalizeAllotments, normalizeCancellationPolicies, IngestShapeError,
} from '../src/index.ts'

const opts = { today: '2027-03-01' }

/** Synthetic channel-manager JSON feed and XML hotel supplier. Neither is a real provider and neither is registered. */
const cmRates = {
  fields: { hotelCode: { path: 'id', level: 0 }, roomCode: { path: 'code', level: 1 }, ratePlanCode: { path: 'plan', level: 2 }, stayDate: { path: 'date', level: 2 }, currency: { path: 'cur', level: 0 }, netAmount: { path: 'net', level: 2 }, taxesIncluded: { path: 'tax', level: 2 }, minStay: { path: 'minLos', level: 2 } },
  recordPath: 'hotels[].rooms[].days[]',
}
const cmFeed = (days) => ({ hotels: [{ id: 'H1', cur: 'AED', rooms: [{ code: 'DBL', days }] }] })

test('JSON channel-manager rates normalize to integer minor units with inherited parent fields', () => {
  const rows = extractJsonRecords(cmFeed([{ date: '2027-03-05', plan: 'BAR', net: '412.50', tax: 'true', minLos: 2 }, { date: '2027-03-06', plan: 'BAR', net: 400, tax: 'false' }]), cmRates)
  const r = normalizeRates(rows, opts)
  assert.equal(r.status, 'COMPLETE')
  assert.deepEqual(r.accepted.map((x) => [x.stayDate, x.netMinor, x.taxesIncluded, x.minStay]), [['2027-03-05', 41250, true, 2], ['2027-03-06', 40000, false, null]])
})

test('unstated tax stays null, and zero/negative/over-scale/past/far-future amounts and dates are rejected with codes only', () => {
  const rows = extractJsonRecords(cmFeed([
    { date: '2027-03-05', plan: 'BAR', net: '100.00' },
    { date: '2027-03-06', plan: 'BAR', net: '0' },
    { date: '2027-03-07', plan: 'BAR', net: '-5' },
    { date: '2027-03-08', plan: 'BAR', net: '10.005' },
    { date: '2026-01-01', plan: 'BAR', net: '10' },
    { date: '2031-01-01', plan: 'BAR', net: '10' },
    { date: '2027-02-30', plan: 'BAR', net: '10' },
    { date: '2027-03-09', plan: 'BAR', net: '1e3' },
  ]), cmRates)
  const r = normalizeRates(rows, opts)
  assert.equal(r.accepted.length, 1)
  assert.equal(r.accepted[0].taxesIncluded, null)
  assert.deepEqual(r.rejected.map((x) => x.code), ['invalid_amount', 'invalid_amount', 'invalid_amount', 'invalid_range', 'invalid_range', 'invalid_date', 'invalid_amount'])
  assert.equal(r.status, 'FAILED')
  assert.ok(!JSON.stringify(r.rejected).includes('BAR'))
})

test('a feed above the reject threshold is FAILED, a feed below it is PARTIAL, an empty feed is FAILED', () => {
  const good = { date: '2027-03-05', plan: 'BAR', net: '100' }
  const rows = extractJsonRecords(cmFeed([good, { ...good, date: '2027-03-06' }, { ...good, date: '2027-03-07' }, { ...good, date: '2027-03-08', net: 'x' }]), cmRates)
  assert.equal(normalizeRates(rows, opts).status, 'PARTIAL')
  assert.equal(normalizeRates(rows, { ...opts, maxRejectBasisPoints: 1000 }).status, 'FAILED')
  assert.equal(normalizeRates([], opts).status, 'FAILED')
})

test('conflicting duplicates are both rejected; identical duplicates collapse', () => {
  const d = { date: '2027-03-05', plan: 'BAR', net: '100' }
  const r = normalizeRates(extractJsonRecords(cmFeed([d, { ...d, net: '120' }, { date: '2027-03-06', plan: 'BAR', net: '90' }, { date: '2027-03-06', plan: 'BAR', net: '90' }]), cmRates), opts)
  assert.deepEqual(r.accepted.map((x) => x.stayDate), ['2027-03-06'])
  assert.deepEqual(r.rejected.map((x) => [x.index, x.code]), [[0, 'duplicate_conflict'], [1, 'duplicate_conflict']])
})

test('JSON shape errors and prototype paths are refused', () => {
  assert.throws(() => extractJsonRecords('not json', cmRates), IngestShapeError)
  assert.throws(() => extractJsonRecords({ hotels: 'x' }, cmRates), IngestShapeError)
  assert.throws(() => extractJsonRecords({ a: [] }, { recordPath: '__proto__[]', fields: {} }), IngestShapeError)
})

const xmlAllot = `<Feed><Hotel code="H1"><Room code="DBL">
  <Day date="2027-03-05" avail="4"/><Day date="2027-03-06" mode="freesale"/><Day date="2027-03-07" avail="-1"/>
  <Day date="2027-03-08" mode="allotment"/><Day date="2027-03-09" avail="0" stop="true" release="3"/><Day date="2027-03-10"/>
</Room></Hotel></Feed>`
const xmlAllotSpec = { recordPath: ['Hotel', 'Room', 'Day'], fields: { hotelCode: { path: '@code', level: 0 }, roomCode: { path: '@code', level: 1 }, stayDate: { path: '@date' }, available: { path: '@avail' }, mode: { path: '@mode' }, stopSell: { path: '@stop' }, releaseDays: { path: '@release' } } }

test('XML allotments: counts, free sale, stop-sell; missing or negative counts are rejected, never zero or unlimited', () => {
  const r = normalizeAllotments(extractXmlRecords(xmlAllot, xmlAllotSpec), opts)
  assert.deepEqual(r.accepted.map((a) => [a.stayDate, a.mode, a.available, a.stopSell, a.releaseDays]), [
    ['2027-03-05', 'ALLOTMENT', 4, false, null], ['2027-03-06', 'FREE_SALE', null, false, null], ['2027-03-09', 'ALLOTMENT', 0, true, 3]])
  assert.deepEqual(r.rejected.map((x) => [x.index, x.code, x.field]), [[2, 'invalid_integer', 'available'], [3, 'missing_field', 'available'], [5, 'missing_field', 'mode']])
})

test('XML with DOCTYPE or entities is refused as a shape error', () => {
  assert.throws(() => extractXmlRecords('<!DOCTYPE x [<!ENTITY a "b">]><Feed/>', xmlAllotSpec), IngestShapeError)
})

const policySpec = { recordPath: ['Hotel', 'Plan', 'Rule'], fields: { hotelCode: { path: '@code', level: 0 }, ratePlanCode: { path: '@code', level: 1 }, nonRefundable: { path: '@nr', level: 1 }, currency: { path: '@cur', level: 1 }, from: { path: '@from' }, daysBefore: { path: '@days' }, arrivalDate: { path: '@arrival' }, penaltyType: { path: '@type' }, penaltyValue: { path: '@value' } } }
const policies = (rules, planAttrs = '') => `<Feed><Hotel code="H1"><Plan code="BAR" cur="AED" ${planAttrs}>${rules}</Plan></Hotel></Feed>`

test('cancellation policies: absolute and relative windows normalize, sorted, with percent as basis points', () => {
  const xml = policies('<Rule from="2027-04-10T00:00:00+04:00" type="percent" value="50.5"/><Rule days="14" arrival="2027-05-01" type="nights" value="1"/><Rule from="2027-04-28T12:00:00+04:00" type="fixed" value="150.00"/>')
  const r = normalizeCancellationPolicies(extractXmlRecords(xml, policySpec), { ...opts, hotelUtcOffset: '+04:00', cutoffTime: '18:00' })
  assert.equal(r.status, 'COMPLETE')
  assert.deepEqual(r.accepted[0].windows, [
    { from: '2027-04-09T20:00:00.000Z', penalty: { type: 'PERCENT', basisPoints: 5050 } },
    { from: '2027-04-17T14:00:00.000Z', penalty: { type: 'NIGHTS', nights: 1 } },
    { from: '2027-04-28T08:00:00.000Z', penalty: { type: 'FIXED', amountMinor: 15000, currency: 'AED' } }])
})

test('relative windows without a configured cut-off, bare local times, bad percents and unordered duplicates reject the plan', () => {
  const rel = policies('<Rule days="14" arrival="2027-05-01" type="full"/>')
  assert.equal(normalizeCancellationPolicies(extractXmlRecords(rel, policySpec), opts).accepted.length, 0)
  assert.equal(normalizeCancellationPolicies(extractXmlRecords(policies('<Rule from="2027-04-10T00:00:00" type="full"/>'), policySpec), opts).rejected[0].code, 'invalid_date')
  assert.equal(normalizeCancellationPolicies(extractXmlRecords(policies('<Rule from="2027-04-10T00:00:00Z" type="percent" value="101"/>'), policySpec), opts).rejected[0].code, 'invalid_range')
  const same = policies('<Rule from="2027-04-10T00:00:00Z" type="full"/><Rule from="2027-04-10T00:00:00Z" type="nights" value="1"/>')
  const r = normalizeCancellationPolicies(extractXmlRecords(same, policySpec), opts)
  assert.equal(r.accepted.length, 0)
  assert.equal(r.status, 'FAILED')
})

test('non-refundable plans must carry only FULL windows; a refundable plan with no windows is ambiguous', () => {
  const ok = normalizeCancellationPolicies(extractXmlRecords(policies('<Rule from="2027-03-01T00:00:00Z" type="full"/>', 'nr="true"'), policySpec), opts)
  assert.equal(ok.accepted[0].nonRefundable, true)
  const mixed = normalizeCancellationPolicies(extractXmlRecords(policies('<Rule from="2027-03-01T00:00:00Z" type="percent" value="10"/>', 'nr="true"'), policySpec), opts)
  assert.equal(mixed.accepted.length, 0)
  const none = normalizeCancellationPolicies(extractXmlRecords('<Feed><Hotel code="H1"><Plan code="BAR"><Rule/></Plan></Hotel></Feed>', policySpec), opts)
  assert.equal(none.accepted.length, 0)
})
