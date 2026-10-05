import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { navSections, flatNav, isActiveRoute } from '../components/layout/nav-config'
import { userInitials } from './auth/identity'
import { summarizeSellability, SELLABILITY_CHECKS, WARNING_TEXT } from './sellability'
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
  for (const gone of ['/finance', '/pricing', '/distribution', '/reports', '/notifications', '/tenants', '/users']) assert.ok(!navSections.flatMap((s) => s.items).some((item) => item.href === gone), `${gone} must not be in the sidebar`)
  for (const present of ['/dashboard', '/suppliers', '/hotels', '/board-basis', '/mappings', '/contracts', '/rates/plans', '/rates', '/sellability', '/access', '/settings']) assert.ok(hrefs.includes(present), present)
  const sidebar = readFileSync(join(root, 'components/layout/Sidebar.tsx'), 'utf8')
  assert.doesNotMatch(sidebar, /mock data|Admin User|Platform Administrator|enforced later/)
})

test('operations modules are in the sidebar only with a declared permission, and each is backed by a real page', () => {
  const ops = ['/operations', '/bookings', '/holds', '/reconciliation', '/cancellations', '/connectors', '/finance/wallets', '/finance/ledger', '/audit']
  for (const href of ops) {
    const item = flatNav.find((n) => n.href === href)
    assert.ok(item, `${href} must be listed`)
    assert.ok(item.requires, `${href} must declare the permission that gates it`)
    const page = readFileSync(join(root, 'app', '(dashboard)', ...href.split('/').filter(Boolean), 'page.tsx'), 'utf8')
    assert.doesNotMatch(page, /FeatureUnavailable/, `${href} must not be a placeholder`)
    assert.match(page, /lib\/data\/operations/, `${href} must read the operations API`)
  }
})

test('placeholder routes that remain say so and render no records', () => {
  for (const rel of ['finance/page.tsx', 'finance/payments/page.tsx', 'reports/page.tsx', 'notifications/page.tsx', 'pricing/page.tsx', 'distribution/page.tsx', 'users/page.tsx']) {
    assert.match(readFileSync(join(root, 'app', '(dashboard)', rel), 'utf8'), /FeatureUnavailable/, rel)
  }
})

test('tenant directory is a read-only page over the audited platform API', () => {
  for (const rel of ['tenants/page.tsx', 'tenants/[id]/page.tsx']) {
    const page = readFileSync(join(root, 'app', '(dashboard)', rel), 'utf8')
    assert.doesNotMatch(page, /FeatureUnavailable/, rel)
    assert.match(page, /lib\/data\/server/, rel)
    assert.match(page, /ServerLoadFailure/, `${rel} must show 401/403/failure states, never an empty list`)
    assert.doesNotMatch(page, /method:\s*'(POST|PUT|PATCH|DELETE)'|<form/, `${rel} must stay read-only`)
  }
})

test('operations pages never hide a failure behind an empty list or a catch fallback', () => {
  const files = production.filter((f) => /components\/ops\/|data\/operations/.test(f) || /\(dashboard\)\/(bookings|holds|reconciliation|cancellations|connectors|operations|audit|finance)\//.test(f))
  assert.ok(files.length >= 10)
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /\.catch\(\s*\(\)\s*=>\s*(\[\]|\{\}|null|undefined)/, `${file}: catch must not substitute empty data`)
    assert.doesNotMatch(text, /DEMO_MODE|demoData|fallbackData/, file)
  }
})

const hotelFiles = () => production.filter((f) => /components[\\/]hotels[\\/]|\(dashboard\)[\\/]hotels[\\/]\[id\][\\/]page|\(dashboard\)[\\/]hotels[\\/]page|\(dashboard\)[\\/]exceptions[\\/]page|lib[\\/]hotel-ui\.ts|lib[\\/]data[\\/]hotel-commercial/.test(f))

test('hotel commercial UI holds no commercial authority: no readiness, remaining-inventory, expiry or sellability rules in React', () => {
  const files = hotelFiles()
  assert.ok(files.length >= 14, `expected the hotel commercial files, found ${files.length}`)
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /allotment\s*-\s*|\.sold\s*\+|\.held\s*\+|-\s*\w+\.sold/, `${file}: remaining inventory must come from the API`)
    assert.doesNotMatch(text, /evaluateContractedStay|evaluateNightSellability|buildStaySnapshot|contractStateOf/, `${file}: canonical evaluators live in the API`)
    assert.doesNotMatch(text, /daysToExpiry\s*[<>]=?\s*\d|CONTRACT_EXPIRING_DAYS\s*[-+*]|new Date\([^)]*validTo/, `${file}: expiry state must come from the API`)
    assert.doesNotMatch(text, /readiness\s*=\s*['"](READY|PARTIAL|BLOCKED)['"]/, `${file}: readiness is never assigned in the browser`)
    assert.doesNotMatch(text, /Math\.random|setTimeout|DEMO_MODE|mockData|fallbackData/, `${file}: no simulated data`)
    assert.doesNotMatch(text, /\.catch\(\s*\(\)\s*=>\s*(\[\]|\{\}|null|undefined)/, `${file}: a failure is never turned into empty data`)
  }
})

test('the hotel list is server-paginated: it never loads the whole hotel catalogue into the browser', () => {
  const list = readFileSync(join(root, 'app', '(dashboard)', 'hotels', 'page.tsx'), 'utf8')
  assert.doesNotMatch(list, /['"`]\/supply\/hotels/, 'the list must not fetch /supply/hotels')
  assert.match(list, /getHotelsCommercial/); assert.match(list, /Pager/); assert.match(list, /PAGE_SIZE/)
  assert.doesNotMatch(list, /\.filter\(\(hotel\)/, 'filtering happens on the server')
})

test('every issue and gate section is a hotel tab, and tabs requiring a permission are declared', () => {
  const page = readFileSync(join(root, 'app', '(dashboard)', 'hotels', '[id]', 'page.tsx'), 'utf8')
  for (const permission of ['supply.contracts.read', 'supply.mappings.read', 'supply.rates.read', 'booking.read', 'audit.read']) assert.match(page, new RegExp(permission.replace('.', '\\.')))
  assert.ok(flatNav.some((n) => n.href === '/exceptions' && n.requires === 'supply.hotels.read'))
  assert.equal(flatNav.some((n) => n.href === '/operations/hotels'), false)
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

test('sellability warnings are surfaced once, in plain language, without changing the result', () => {
  const warned = { eligible: true, status: 'ELIGIBLE_FOR_FUTURE_SEARCH' as const, reasons: [], warnings: ['HOTEL_CONTENT_NOT_COMPLETE'] }
  const summary = summarizeSellability([{ stayDate: '2026-10-05', result: warned }, { stayDate: '2026-10-06', result: warned }])
  assert.equal(summary.sellable, true)
  assert.deepEqual(summary.warnings, ['HOTEL_CONTENT_NOT_COMPLETE'])
  assert.match(WARNING_TEXT.HOTEL_CONTENT_NOT_COMPLETE, /not see it in search/)
  assert.deepEqual(summarizeSellability([{ stayDate: '2026-10-05', result: { eligible: true, status: 'ELIGIBLE_FOR_FUTURE_SEARCH', reasons: [] } }]).warnings, [])
})

test('department navigation (ADR 0015): grouped by department, live modules only, every entry has a real page', () => {
  assert.deepEqual(navSections.map((s) => s.label), ['Control tower', 'Supply & contracting', 'Rates & inventory', 'Reservations', 'Clients & service', 'Finance', 'Platform'])
  const items = navSections.flatMap((s) => s.items)
  assert.equal(new Set(items.map((i) => i.href)).size, items.length, 'a route appears once in the sidebar')
  for (const item of items) {
    assert.ok(existsSync(join(root, 'app', '(dashboard)', ...item.href.split('/').filter(Boolean), 'page.tsx')), `${item.href} needs a page`)
    assert.ok(item.icon, `${item.href} needs an icon`)
    assert.doesNotMatch(readFileSync(join(root, 'app', '(dashboard)', ...item.href.split('/').filter(Boolean), 'page.tsx'), 'utf8'), /FeatureUnavailable/, `${item.href} must not be a placeholder`)
  }
  for (const planned of ['Promotions', 'Risk flags', 'Refunds', 'Tenants', 'Users', 'Commercial profiles', 'Credit and wallet limits', 'Escalation policies']) assert.ok(!items.some((i) => i.label === planned), `${planned} is not built and must not be in the sidebar`)
})

test('dashboard sellability card reads the API summary and computes nothing in the browser', () => {
  const card = readFileSync(join(root, 'components', 'dashboard', 'SellabilityCard.tsx'), 'utf8')
  assert.match(card, /getHotelsSummary/)
  assert.doesNotMatch(card, /evaluate|Math\.|reduce\(|\.filter\(|toFixed|\/ s\.totalHotels|\* 100/, 'no readiness or percentage arithmetic in React')
  assert.match(card, /OpsState/, 'failures use the shared distinct states, never zero')
  assert.match(readFileSync(join(root, 'app', '(dashboard)', 'dashboard', 'page.tsx'), 'utf8'), /<SellabilityCard \/>/)
})

test('dashboard department slices come from the readiness API and the department catalogue', () => {
  const slices = readFileSync(join(root, 'components', 'dashboard', 'DepartmentSlices.tsx'), 'utf8')
  assert.match(slices, /getOpsReadiness/)
  assert.match(slices, /departments\.find/, 'names come from the catalogue')
  assert.doesNotMatch(slices, /Math\.|reduce\(|toFixed|\* 100|evaluate/, 'no arithmetic or readiness logic in React')
  assert.match(slices, /state === 'unavailable'/, 'a denied section is shown as denied, never as zeros')
  for (const planned of ['commercial']) assert.doesNotMatch(slices, new RegExp(`id="${planned}"`), `${planned} is not built`)
  assert.match(readFileSync(join(root, 'app', '(dashboard)', 'dashboard', 'page.tsx'), 'utf8'), /<DepartmentSlices \/>/)
})

test('finance and audit dashboard slices read their summary endpoints, show currencies separately and format only from minor units', () => {
  const src = readFileSync(join(root, 'components', 'dashboard', 'FinanceAuditSlices.tsx'), 'utf8')
  assert.match(src, /getFinanceSummary/); assert.match(src, /getAuditSummary/)
  assert.match(src, /formatMinorUnits/)
  assert.doesNotMatch(src, /Number\(|parseFloat|toFixed|Math\.|\* 100|BigInt/, 'no floating-point or ad hoc money arithmetic in React')
  assert.doesNotMatch(src, /availableCreditMinor\s*[+-]|\.reduce\([^)]*Minor/, 'currencies are never added together in the browser')
  assert.match(src, /state === 'unavailable'/, 'an unreadable section is shown as denied, never zero')
  assert.match(readFileSync(join(root, 'components', 'dashboard', 'DepartmentSlices.tsx'), 'utf8'), /<FinanceAuditSlices \/>/)
})

test('governance slices and pages read their own summary endpoints and do no arithmetic in the browser', () => {
  const slices = readFileSync(join(root, 'components', 'dashboard', 'GovernanceSlices.tsx'), 'utf8')
  for (const fn of ['getMarketsSummary', 'getReliabilitySummary', 'getAccessReviewSummary']) assert.match(slices, new RegExp(fn))
  assert.doesNotMatch(slices, /Math\.|toFixed|\* 100|\.reduce\(|members\.[a-zA-Z]+ \+ /, 'no counting or percentages in React')
  for (const [page, fn] of [['markets', 'getMarketsSummary'], ['reliability', 'getReliabilitySummary'], ['access-review', 'getAccessReviewUsers']]) {
    const src = readFileSync(join(root, 'app', '(dashboard)', page, 'page.tsx'), 'utf8')
    assert.match(src, new RegExp(fn)); assert.match(src, /OpsState/); assert.doesNotMatch(src, /FeatureUnavailable|Math\.|toFixed/)
  }
  assert.doesNotMatch(readFileSync(join(root, 'app', '(dashboard)', 'access-review', 'page.tsx'), 'utf8'), /password|passwordHash/i, 'no credential material is ever shown')
})

test('markup page manages rules only: the API prices, the browser does no pricing arithmetic', () => {
  const page = readFileSync(join(root, 'app', '(dashboard)', 'commercial', 'markups', 'page.tsx'), 'utf8')
  assert.match(page, /getMarkupRules/); assert.match(page, /OpsState/)
  assert.doesNotMatch(page, /parseFloat|toFixed|Math\.round|Math\.floor|\*\s*\(\s*1\s*\+|netAmount|sellAmount/, 'no price or markup arithmetic in React')
  assert.match(page, /canRequestActivation/); assert.match(page, /approval\??\.canDecide/); assert.match(page, /canExecute/, 'buttons come from the API flags')
  assert.doesNotMatch(page, /method: 'PATCH'|method: 'PUT'|method: 'DELETE'/, 'rules are immutable: no update or delete')
})

test('markup impact panel shows the API counts and money, with no arithmetic or currency mixing in the browser', () => {
  const src = readFileSync(join(root, 'components', 'commercial', 'MarkupImpact.tsx'), 'utf8')
  assert.match(src, /getMarkupImpact/); assert.match(src, /formatMinorUnits/); assert.match(src, /OpsState/)
  assert.doesNotMatch(src, /Number\(|parseFloat|toFixed|Math\.|BigInt|\.reduce\(/, 'no money or count arithmetic in React')
})

test('clients, service and distribution pages use their own APIs and take no money, credit or pricing action (ADR 0019)', () => {
  for (const [page, fn] of [['clients/agencies', 'getAgencies'], ['service/cases', 'getCases'], ['distribution/restrictions', 'getRestrictions']]) {
    const src = readFileSync(join(root, 'app', '(dashboard)', ...page.split('/'), 'page.tsx'), 'utf8')
    assert.match(src, new RegExp(fn)); assert.match(src, /OpsState/); assert.doesNotMatch(src, /FeatureUnavailable|Math\.|toFixed|creditLimit|from '@\/lib\/data\/(operations|commercial)'|formatMinorUnits/, `${page} must not touch money, wallets or pricing`)
  }
  const credit = readFileSync(join(root, 'components', 'clients', 'AgencyCreditPanel.tsx'), 'utf8')
  assert.match(credit, /formatMinorUnits/); assert.match(credit, /parseMajorToMinor/); assert.match(credit, /OpsState/)
  assert.doesNotMatch(credit, /Math\.|toFixed|parseFloat|Number\(/, 'credit amounts are integer minor units, never floats')
  const detail = readFileSync(join(root, 'app', '(dashboard)', 'service', 'cases', '[id]', 'page.tsx'), 'utf8')
  assert.match(detail, /allowedTransitions/, 'status buttons come from the API'); assert.match(detail, /cannot be edited or removed/)
  assert.doesNotMatch(detail, /method: 'PUT'|method: 'DELETE'|editNote|deleteNote/, 'notes are append-only')
  assert.match(readFileSync(join(root, 'app', '(dashboard)', 'clients', 'agencies', 'page.tsx'), 'utf8'), /does not block|still signs in/i, 'states that inactive is a directory state only')
  const slices = readFileSync(join(root, 'components', 'dashboard', 'DomainSlices.tsx'), 'utf8')
  for (const fn of ['getClientsSummary', 'getServiceSummary', 'getDistributionSummary']) assert.match(slices, new RegExp(fn))
  assert.doesNotMatch(slices, /Math\.|toFixed|\.reduce\(/)
})

test('rate certification UI holds no pricing or certification authority and shows only API answers', () => {
  const files = production.filter((f) => /components[\\/]rate-certification[\\/]|\(dashboard\)[\\/]rate-certification[\\/]|lib[\\/]data[\\/]rate-certification|lib[\\/]rate-certification-ui/.test(f))
  assert.ok(files.length >= 8, `expected the rate certification files, found ${files.length}`)
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /evaluateContractedStay|buildStaySnapshot|markupMinor\(|applyPercentMarkup|resolveMarkupBasisPoints/, `${file}: pricing lives in the API`)
    assert.doesNotMatch(text, /BigInt\(|parseFloat|\.toFixed\(|Number\([^)]*[Mm]inor/, `${file}: money is never computed in the browser`)
    assert.doesNotMatch(text, /status\s*=\s*['"](PASS|WARN|FAIL|CERTIFIED|NOT_READY)['"]/, `${file}: a certification is never assigned in the browser`)
    assert.doesNotMatch(text, /Math\.random|setTimeout|DEMO_MODE|mockData|fallbackData/, `${file}: no simulated data`)
    assert.doesNotMatch(text, /\.catch\(\s*\(\)\s*=>\s*(\[\]|\{\}|null|undefined)/, `${file}: a failure is never turned into empty data`)
    assert.doesNotMatch(text, /method:\s*['"](PUT|PATCH|DELETE)['"]/, `${file}: the audit is read-only`)
  }
  const data = readFileSync(join(root, 'lib', 'data', 'rate-certification.ts'), 'utf8')
  assert.equal([...data.matchAll(/method: '(\w+)'/g)].map((m) => m[1]).join(','), 'POST', 'the only non-GET call is the read-only simulator')
  assert.ok(flatNav.some((n) => n.href === '/rate-certification' && n.requires === 'supply.rates.read'))
})

test('the pool workspace holds no stock or reconciliation arithmetic: counters, availability and attribution come from the API', () => {
  const text = readFileSync(join(root, 'components', 'hotels', 'panels', 'PoolWorkspace.tsx'), 'utf8')
  assert.doesNotMatch(text, /capacity\s*-\s*\w+\.(sold|held)|\.sold\s*\+|\.held\s*\+|-\s*\w+\.sold|evaluateContractedStay|BigInt\(|parseFloat|\.toFixed\(/, 'no stock arithmetic in React')
  assert.doesNotMatch(text, /method:\s*['"](PUT|PATCH|DELETE)['"]/)
  const data = readFileSync(join(root, 'lib', 'data', 'hotel-inventory.ts'), 'utf8')
  assert.match(data, /poolCapacityPreview/); assert.match(data, /poolCapacityApply/)
})
