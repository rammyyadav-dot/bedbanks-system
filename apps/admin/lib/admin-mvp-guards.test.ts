import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { navSections, flatNav, isActiveRoute } from '../components/layout/nav-config'
import { userInitials } from './auth/identity'
import { summarizeSellability, SELLABILITY_CHECKS } from './sellability'
import { parseMajorToMinor, minorToMajorInput, formatMinorUnits } from './minor-units'
import { buildSevenDayRates, dateRange } from './dubai-operations'

const root = join(import.meta.dirname, '..')
const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  if (name === 'node_modules' || name === '.next') return []
  const path = join(dir, name)
  return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : []
})
const production = [...sources(join(root, 'app')), ...sources(join(root, 'components')), ...sources(join(root, 'lib'))]

test('Admin has no mock module and nothing imports one', () => {
  assert.equal(existsSync(join(root, 'lib', 'mock')), false)
  for (const file of production) assert.doesNotMatch(readFileSync(file, 'utf8'), /lib\/mock|from ['"]\.\.?\/mock|mockData|searchComparison/, file)
})

test('Admin money is never converted with floating point', () => {
  for (const file of production) {
    const text = readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /Number\([^)]*(minor|Minor)[^)]*\)\s*\/\s*100/, file)
    assert.doesNotMatch(text, /\.toFixed\(/, file)
    assert.doesNotMatch(text, /parseFloat\(/, file)
  }
})

test('MVP navigation lists only authoritative commercial modules and no stale mock banner', () => {
  const hrefs = flatNav.map((item) => item.href)
  for (const gone of ['/bookings', '/cancellations', '/finance', '/pricing', '/distribution', '/reports', '/notifications', '/tenants', '/users', '/audit']) assert.ok(!navSections.flatMap((s) => s.items).some((item) => item.href === gone), `${gone} must not be in the sidebar`)
  for (const present of ['/dashboard', '/suppliers', '/hotels', '/board-basis', '/mappings', '/contracts', '/rates/plans', '/rates', '/sellability', '/access', '/settings']) assert.ok(hrefs.includes(present), present)
  const sidebar = readFileSync(join(root, 'components/layout/Sidebar.tsx'), 'utf8')
  assert.doesNotMatch(sidebar, /mock data|Admin User|Platform Administrator|enforced later/)
})

test('sidebar highlights only the most specific route', () => {
  assert.equal(isActiveRoute('/rates/plans/abc', '/rates/plans'), true)
  assert.equal(isActiveRoute('/rates/plans/abc', '/rates'), false)
  assert.equal(isActiveRoute('/rates', '/rates'), true)
  assert.equal(isActiveRoute('/contracts/new', '/contracts'), true)
})

test('identity initials come from the authenticated name or email', () => {
  assert.equal(userInitials({ name: 'Layla Hassan', email: 'x@y.test' }), 'LH')
  assert.equal(userInitials({ name: 'Madonna', email: 'x@y.test' }), 'M')
  assert.equal(userInitials({ name: null, email: 'ops.admin@fbeds.test' }), 'OP')
  assert.equal(userInitials({ name: '   ', email: 'z@y.test' }), 'Z')
})

test('major-to-minor parsing is exact, currency-aware and rejects rounding', () => {
  assert.equal(parseMajorToMinor('450', 'AED'), '45000')
  assert.equal(parseMajorToMinor('450.5', 'AED'), '45050')
  assert.equal(parseMajorToMinor('0.05', 'AED'), '5')
  assert.equal(parseMajorToMinor('1500', 'JPY'), '1500')
  assert.equal(parseMajorToMinor('1.234', 'KWD'), '1234')
  assert.equal(parseMajorToMinor('450.555', 'AED'), null)
  assert.equal(parseMajorToMinor('1500.5', 'JPY'), null)
  assert.equal(parseMajorToMinor('-1', 'AED'), null)
  assert.equal(parseMajorToMinor('1e3', 'AED'), null)
  assert.equal(parseMajorToMinor('', 'AED'), null)
  assert.equal(parseMajorToMinor('90071992547409.93', 'USD'), null)
  assert.equal(minorToMajorInput('45000', 'AED'), '450.00')
  assert.equal(minorToMajorInput('5', 'AED'), '0.05')
  assert.equal(minorToMajorInput('1234', 'KWD'), '1.234')
  assert.equal(formatMinorUnits(parseMajorToMinor('299.99', 'AED')!, 'AED'), 'AED 299.99')
})

test('rate loader honours currency fraction digits and supports 30-day windows', () => {
  const kwd = { id: 'rp', occupancy: 2, currency: 'KWD', minStay: 1 }
  assert.ok(buildSevenDayRates(kwd, '2026-10-20', '12.345', 'SELL').every((row) => row.amountMinor === '12345'))
  assert.equal(buildSevenDayRates(kwd, '2026-10-20', '12.345', 'SELL', 30).length, 30)
  assert.deepEqual(dateRange('2026-10-30', 3), ['2026-10-30', '2026-10-31', '2026-11-01'])
})

test('sellability summary shows PASS/FAIL only from backend reason codes', () => {
  const ok = { eligible: true, status: 'ELIGIBLE_FOR_FUTURE_SEARCH' as const, reasons: [] }
  const pass = summarizeSellability([{ stayDate: '2026-10-05', result: ok }, { stayDate: '2026-10-06', result: ok }])
  assert.equal(pass.sellable, true)
  assert.ok(pass.checks.length === SELLABILITY_CHECKS.length && pass.checks.every((check) => check.status === 'PASS'))

  const fail = summarizeSellability([
    { stayDate: '2026-10-05', result: { eligible: false, status: 'NOT_ELIGIBLE', reasons: ['DAILY_RATE_MISSING_OR_INVALID'] } },
    { stayDate: '2026-10-06', result: { eligible: false, status: 'NOT_ELIGIBLE', reasons: ['STOP_SELL', 'SOME_FUTURE_CODE'] } },
  ])
  assert.equal(fail.sellable, false)
  const byLabel = Object.fromEntries(fail.checks.map((check) => [check.label, check]))
  assert.equal(byLabel['Daily Rates'].status, 'FAIL')
  assert.deepEqual(byLabel['Daily Rates'].findings, [{ stayDate: '2026-10-05', code: 'DAILY_RATE_MISSING_OR_INVALID' }])
  assert.equal(byLabel['Stop Sell'].status, 'FAIL')
  assert.equal(byLabel['Availability'].status, 'PASS')
  assert.deepEqual(byLabel['Other'].findings, [{ stayDate: '2026-10-06', code: 'SOME_FUTURE_CODE' }])
  assert.equal(summarizeSellability([]).sellable, false)
})

import { pickActiveTenantId, setActiveTenantId, activeTenantHeaders } from './api/tenant-context'
test('browser API calls carry the validated active tenant header', () => {
  assert.equal(pickActiveTenantId([]), null)
  assert.equal(pickActiveTenantId([{ tenantId: 't-member', role: 'member' }, { tenantId: 't-owner', role: 'owner' }]), 't-owner')
  assert.equal(pickActiveTenantId([{ tenantId: 't-a', role: 'member' }, { tenantId: 't-b', role: 'member' }]), 't-a')
  setActiveTenantId(null); assert.deepEqual(activeTenantHeaders(), {})
  setActiveTenantId('t-owner'); assert.deepEqual(activeTenantHeaders(), { 'x-fbeds-tenant-id': 't-owner' })
  setActiveTenantId(null)
})
