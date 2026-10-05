import type {
  CertificationStatus, HotelCertification, HotelDistributionStatus, MarkupRuleAuditRow, RateFinding, RateFindingCode, RateFindingSeverity, RatePlanAuditDetail, RatePlanAuditRow,
  RateRowClass, RateRowClassCounts, RemediationItem, RemediationPriority, SimulatedNight, SimulationResult,
} from '@bedbanks/contracts'
import { markupMinor } from '@bedbanks/pricing'
import { assessHotel, contractStateOf, type AssessHotelInput, type AssessPlan, type HotelAssessment, type PlanAssessment } from '../supply/commercial-assessment'
import { evaluateContractedStay } from '../supply/contracted-sellability'
import { buildStaySnapshot } from '../supply/stay-snapshot'
import { parseMarketRules } from '../supply/market-rules'
import { markupResolverFor, resolveMarkupBasisPoints, type MarkupRuleRow } from '../supply/markup-rules'

/**
 * Pure rate plan audit (ADR 0033). It owns no I/O and reads no clock: `today` and `observedAt` are injected.
 *
 * It never decides what sells. Sellability comes from `assessHotel` and `evaluateContractedStay`, the evaluator Agent search uses; this
 * module only classifies the stored rows and reports where the data would make the evaluator refuse, or price wrongly, or where a person
 * should look. Nothing here repairs, merges or deletes anything.
 */
export const RATE_PLAN_CODE_PATTERN = /^[A-Z0-9]+(-[A-Z0-9]+)*$/
export const RATE_PLAN_CODE_MAX = 32
export const MARKUP_VERY_HIGH_BASIS_POINTS = 5_000
const SAMPLE = 5

export type AuditPlan = AssessPlan & { contract: { salesMarkets?: unknown; nationalities?: unknown } }
export interface AuditHotelInput extends Omit<AssessHotelInput, 'plans'> {
  plans: AuditPlan[]
  city: string
  /** Settlement currencies enabled by the launch policy (ADR 0029). */
  enabledCurrencies: readonly string[]
}
export interface HotelAudit { certification: HotelCertification; plans: RatePlanAuditRow[]; assessment: HotelAssessment; details: Map<string, PlanDetailParts> }
export interface PlanDetailParts { calendar: RatePlanAuditDetail['calendar']; contract: RatePlanAuditDetail['contract'] }

const dayOf = (value: Date): string => value.toISOString().slice(0, 10)
const emptyClasses = (): RateRowClassCounts => ({ VALID: 0, QUARANTINED: 0, DEAD: 0, OUTSIDE_CONTRACT: 0, BLOCKED_NO_MARKUP: 0 })
const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0).slice(0, 50) : [])

export function suggestRatePlanCode(code: string): string | null {
  const cleaned = code.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, RATE_PLAN_CODE_MAX).replace(/-+$/g, '')
  return cleaned.length > 0 && cleaned !== code && RATE_PLAN_CODE_PATTERN.test(cleaned) ? cleaned : null
}

// ---- row classification --------------------------------------------------------------------------------------------------
interface ClassifyRow { stayDate: Date; amountMinor: bigint; currency: string; amountBasis: string | null; occupancy: number }

/** The first class that applies. A row is VALID only when the evaluator could price a night from it. */
export function classifyRateRow(plan: AuditPlan, row: ClassifyRow, rules: readonly MarkupRuleRow[]): { rowClass: RateRowClass; reason: 'ZERO' | 'CURRENCY' | 'BASIS' | null } {
  const date = dayOf(row.stayDate)
  if (row.occupancy !== plan.occupancy) return { rowClass: 'DEAD', reason: null }
  if (date < dayOf(plan.contract.validFrom) || date > dayOf(plan.contract.validTo)) return { rowClass: 'OUTSIDE_CONTRACT', reason: null }
  if (row.amountMinor <= 0n) return { rowClass: 'QUARANTINED', reason: 'ZERO' }
  if (row.currency !== plan.currency) return { rowClass: 'QUARANTINED', reason: 'CURRENCY' }
  if (row.amountBasis !== 'NET' && row.amountBasis !== 'SELL') return { rowClass: 'QUARANTINED', reason: 'BASIS' }
  if (row.amountBasis === 'NET' && resolveMarkupBasisPoints(rules, { supplierId: plan.contract.supplierId, hotelId: plan.roomType.hotelId }, date) === null) return { rowClass: 'BLOCKED_NO_MARKUP', reason: null }
  return { rowClass: 'VALID', reason: null }
}

// ---- findings ------------------------------------------------------------------------------------------------------------
class Findings {
  readonly list: RateFinding[] = []
  add(code: RateFindingCode, severity: RateFindingSeverity, message: string, count: number, sample: string[] = []): void {
    this.list.push({ code, severity, message, count, sample: sample.slice(0, SAMPLE) })
  }
}
export const statusOf = (findings: readonly RateFinding[]): CertificationStatus => (findings.some((f) => f.severity === 'FAIL') ? 'FAIL' : findings.some((f) => f.severity === 'WARN') ? 'WARN' : 'PASS')

function basisOf(plan: AuditPlan): RatePlanAuditRow['amountBasis'] {
  const own = plan.dailyRates.filter((r) => r.occupancy === plan.occupancy)
  if (own.length === 0) return 'NONE'
  const bases = new Set(own.map((r) => (r.amountBasis === 'NET' || r.amountBasis === 'SELL' ? r.amountBasis : 'UNVERIFIED')))
  return bases.size > 1 ? 'MIXED' : ([...bases][0] as 'NET' | 'SELL' | 'UNVERIFIED')
}

interface PlanContext {
  input: AuditHotelInput
  assessment: PlanAssessment | undefined
  duplicateCodes: Map<string, string[]>
  duplicateLogical: Map<string, string[]>
  takenCodes: Set<string>
}

function auditPlan(plan: AuditPlan, ctx: PlanContext): { row: RatePlanAuditRow; detail: PlanDetailParts } {
  const { input } = ctx
  const rules = input.markupRules ?? []
  const live = plan.status === 'ACTIVE'
  const f = new Findings()
  const classes = emptyClasses()
  const rowClassByDate = new Map<string, RateRowClass>()
  const zero: string[] = []; const currency: string[] = []; const basisNull: string[] = []; const outside: string[] = []; const dead: string[] = []; const noMarkup: string[] = []
  const ownDates = new Set<string>()
  for (const rate of plan.dailyRates) {
    const date = dayOf(rate.stayDate)
    const { rowClass, reason } = classifyRateRow(plan, rate, rules)
    classes[rowClass] += 1
    if (rate.occupancy === plan.occupancy) { ownDates.add(date); rowClassByDate.set(date, rowClass) }
    if (rowClass === 'DEAD') dead.push(date)
    else if (rowClass === 'OUTSIDE_CONTRACT') outside.push(date)
    else if (rowClass === 'BLOCKED_NO_MARKUP') noMarkup.push(date)
    else if (reason === 'ZERO') zero.push(date)
    else if (reason === 'CURRENCY') currency.push(date)
    else if (reason === 'BASIS') basisNull.push(date)
  }
  const validFrom = dayOf(plan.contract.validFrom); const validTo = dayOf(plan.contract.validTo)
  const expected = input.dates.filter((d) => d >= validFrom && d <= validTo)
  const gaps = expected.filter((d) => !ownDates.has(d))
  const state = contractStateOf(plan.contract, input.today)

  if (!live) {
    f.add('PLAN_NOT_LIVE', 'INFO', `Rate plan is ${plan.status}; it is reported but not certified.`, 1)
  } else {
    if (zero.length) f.add('RATE_AMOUNT_ZERO', 'FAIL', 'Rates stored with a zero amount. The database allows zero, a quote would be refused or free: someone must confirm the intended price.', zero.length, zero)
    if (currency.length) f.add('RATE_CURRENCY_MISMATCH', 'FAIL', `Rates stored in a currency other than the plan currency ${plan.currency}; the evaluator refuses them.`, currency.length, currency)
    if (basisNull.length) f.add('RATE_BASIS_UNVERIFIED', 'FAIL', 'Rates without a verified amount basis (NET or SELL); the evaluator refuses them rather than guess.', basisNull.length, basisNull)
    if (noMarkup.length) f.add('NET_MARKUP_MISSING', 'FAIL', 'NET rates on nights where no ACTIVE markup rule applies; they cannot be sold (ADR 0018).', noMarkup.length, noMarkup)
    if (!input.enabledCurrencies.includes(plan.currency)) f.add('PLAN_CURRENCY_NOT_ENABLED', 'FAIL', `Plan currency ${plan.currency} is not an enabled settlement currency (${input.enabledCurrencies.join(', ')}).`, 1)
    if (plan.currency !== plan.contract.settlementCurrency) f.add('PLAN_CONTRACT_CURRENCY_MISMATCH', 'FAIL', `Plan currency ${plan.currency} differs from the contract settlement currency ${plan.contract.settlementCurrency}.`, 1)
    if (plan.occupancy > plan.roomType.maxOccupancy) f.add('OCCUPANCY_EXCEEDS_ROOM', 'FAIL', `Plan occupancy ${plan.occupancy} exceeds the room maximum ${plan.roomType.maxOccupancy}; no search can match it.`, 1)
    if (state.state === 'EXPIRED' || state.state === 'INACTIVE') f.add('PLAN_CONTRACT_NOT_ACTIVE', 'FAIL', `The plan is ACTIVE but its contract ${plan.contract.code} is ${state.state}.`, 1)
    else if (state.state === 'EXPIRING') f.add('CONTRACT_EXPIRING', 'WARN', `Contract ${plan.contract.code} expires in ${state.daysToExpiry} day${state.daysToExpiry === 1 ? '' : 's'}.`, 1)
    if (classes.VALID === 0) f.add('NO_PRICED_NIGHTS', 'FAIL', 'No night in the window has a rate the evaluator can price.', 1)
    else if (gaps.length) f.add('RATE_GAPS', 'WARN', 'Nights inside contract validity with no rate for the plan occupancy.', gaps.length, gaps)
    const own = plan.dailyRates.filter((r) => r.occupancy === plan.occupancy)
    if (own.some((r) => r.amountBasis === 'NET') && own.some((r) => r.amountBasis === 'SELL')) f.add('RATE_MIXED_BASIS', 'WARN', 'The plan mixes NET and SELL rates across nights; confirm that is intended.', own.length)
    if (outside.length) f.add('RATE_OUTSIDE_CONTRACT', 'WARN', 'Rates stored outside the contract validity dates; they are never sold.', outside.length, outside)
    if (dead.length) f.add('RATE_OTHER_OCCUPANCY', 'WARN', `Rates stored for an occupancy other than the plan occupancy ${plan.occupancy}; search never reads them.`, dead.length, dead)
    const a = ctx.assessment
    if (a && a.counts.availabilityMissing > 0) f.add('AVAILABILITY_GAPS', 'WARN', 'Nights with no availability row (unknown, never sold).', a.counts.availabilityMissing)
    if (a && a.counts.sellable === 0 && classes.VALID > 0) {
      const reasons = new Map<string, number>()
      for (const night of a.nights) for (const reason of night.reasons) reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
      f.add('NO_SELLABLE_NIGHTS', 'WARN', 'Priced, but no night is sellable in the window.', a.counts.nights, [...reasons.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([r]) => r))
    }
    const marketRules = parseMarketRules(plan.contract)
    if (marketRules.salesMarkets === null || marketRules.nationalities === null) f.add('CONTRACT_MARKET_RULE_INVALID', 'FAIL', 'The contract sales-market or nationality list is malformed, so Agent search does not sell it to anyone.', 1)
    else if (marketRules.salesMarkets.length + marketRules.nationalities.length > 0) f.add('CONTRACT_MARKET_RESTRICTED', 'INFO', 'Sold only to the listed buyer markets and guest nationalities. Agent search enforces this; this audit is buyer-independent.', marketRules.salesMarkets.length + marketRules.nationalities.length, [...marketRules.salesMarkets, ...marketRules.nationalities])
    const dupCode = ctx.duplicateCodes.get(plan.id)
    if (dupCode) f.add('DUPLICATE_PLAN_CODE', 'FAIL', `The code ${plan.code} is used by another live plan of this hotel (different contract).`, dupCode.length + 1, dupCode)
    const dupLogical = ctx.duplicateLogical.get(plan.id)
    if (dupLogical) f.add('DUPLICATE_LOGICAL_PLAN', 'FAIL', 'Another live plan has the same room, board, contract, occupancy, currency and refundability under a different code.', dupLogical.length + 1, dupLogical)
    if (!RATE_PLAN_CODE_PATTERN.test(plan.code) || plan.code.length > RATE_PLAN_CODE_MAX) f.add('PLAN_CODE_FORMAT', 'WARN', `Code does not match ${RATE_PLAN_CODE_PATTERN.source} (max ${RATE_PLAN_CODE_MAX}).`, 1)
  }

  let suggested: string | null = null
  if (live && (!RATE_PLAN_CODE_PATTERN.test(plan.code) || plan.code.length > RATE_PLAN_CODE_MAX)) {
    const candidate = suggestRatePlanCode(plan.code)
    suggested = candidate && !ctx.takenCodes.has(candidate) ? candidate : null
  }

  const assessment = ctx.assessment
  const calendar: RatePlanAuditDetail['calendar'] = input.dates.map((date) => {
    const rate = plan.dailyRates.find((r) => r.occupancy === plan.occupancy && dayOf(r.stayDate) === date)
    const night = assessment?.nights.find((n) => n.date === date)
    return { date, rateMinor: rate ? rate.amountMinor.toString() : null, basis: rate?.amountBasis === 'NET' || rate?.amountBasis === 'SELL' ? rate.amountBasis : null, rowClass: rowClassByDate.get(date) ?? null, sellable: night?.sellable ?? false, reasons: night?.reasons ?? (live ? [] : ['RATE_PLAN_INACTIVE']) }
  })
  const row: RatePlanAuditRow = {
    ratePlanId: plan.id, code: plan.code, hotelId: plan.roomType.hotelId, hotelName: input.hotel.name, roomName: plan.roomType.name, boardCode: plan.boardBasis.code.trim(),
    contractCode: plan.contract.code, supplierName: plan.contract.supplier.displayName, planStatus: plan.status, contractStatus: plan.contract.status,
    occupancy: plan.occupancy, currency: plan.currency, live, status: live ? statusOf(f.list) : 'PASS',
    nights: input.dates.length, sellableNights: assessment?.counts.sellable ?? 0, rowClasses: classes, amountBasis: basisOf(plan), findings: f.list, suggestedCode: suggested,
  }
  return { row, detail: { calendar, contract: { validFrom, validTo, settlementCurrency: plan.contract.settlementCurrency, salesMarkets: stringList(plan.contract.salesMarkets), nationalities: stringList(plan.contract.nationalities) } } }
}

// ---- hotel ---------------------------------------------------------------------------------------------------------------
function groups(plans: AuditPlan[], keyOf: (plan: AuditPlan) => string): Map<string, string[]> {
  const byKey = new Map<string, AuditPlan[]>()
  for (const plan of plans) byKey.set(keyOf(plan), [...(byKey.get(keyOf(plan)) ?? []), plan])
  const out = new Map<string, string[]>()
  for (const members of byKey.values()) if (members.length > 1) for (const member of members) out.set(member.id, members.filter((m) => m.id !== member.id).map((m) => m.code))
  return out
}

export function auditHotel(input: AuditHotelInput): HotelAudit {
  const assessment = assessHotel({ ...input, plans: input.plans })
  const livePlans = input.plans.filter((p) => p.status === 'ACTIVE')
  const duplicateCodes = groups(livePlans, (p) => p.code)
  const duplicateLogical = groups(livePlans, (p) => [p.roomTypeId, p.boardBasisId, p.contractId, p.occupancy, p.currency, p.refundable].join('|'))
  const takenCodes = new Set(input.plans.map((p) => p.code))
  const plans: RatePlanAuditRow[] = []
  const details = new Map<string, PlanDetailParts>()
  for (const plan of [...input.plans].sort((a, b) => a.roomType.name.localeCompare(b.roomType.name) || a.code.localeCompare(b.code) || a.id.localeCompare(b.id))) {
    const { row, detail } = auditPlan(plan, { input, assessment: assessment.plans.find((p) => p.plan.id === plan.id), duplicateCodes, duplicateLogical, takenCodes })
    plans.push(row)
    details.set(plan.id, detail)
  }
  const live = plans.filter((p) => p.live)
  const blockers: string[] = []; const warnings: string[] = []
  if (live.length === 0) blockers.push('No live rate plan')
  for (const gate of assessment.gates) {
    if (gate.state === 'FAIL' && gate.key !== 'sellability' && !(live.length === 0 && ['dailyRates', 'availability', 'stopSell', 'inventory'].includes(gate.key))) blockers.push(`${gate.label}: ${gate.detail}`)
    if (gate.state === 'WARN') warnings.push(`${gate.label}: ${gate.detail}`)
  }
  if (live.length > 0 && !assessment.agentSellable) blockers.push('No night is sellable in the window')
  const failing = live.filter((p) => p.status === 'FAIL'); const warning = live.filter((p) => p.status === 'WARN')
  if (failing.length) blockers.push(`${failing.length} live rate plan${failing.length === 1 ? '' : 's'} failed certification`)
  if (warning.length) warnings.push(`${warning.length} live rate plan${warning.length === 1 ? '' : 's'} with warnings`)
  const status: HotelDistributionStatus = blockers.length > 0 ? 'NOT_READY' : warnings.length > 0 ? 'READY_WITH_WARNINGS' : 'CERTIFIED'
  const certification: HotelCertification = {
    hotelId: input.hotel.id, hotelName: input.hotel.name, city: input.city, status, blockers, warnings,
    plans: { total: plans.length, live: live.length, pass: live.filter((p) => p.status === 'PASS').length, warn: warning.length, fail: failing.length },
    sellableNights: assessment.plans.reduce((n, p) => n + p.counts.sellable, 0), totalNights: assessment.plans.reduce((n, p) => n + p.counts.nights, 0),
  }
  return { certification, plans, assessment, details }
}

// ---- markup rules ----------------------------------------------------------------------------------------------------------
export interface MarkupRuleInput { id: string; scope: 'TENANT_DEFAULT' | 'SUPPLIER' | 'HOTEL'; supplierId: string | null; hotelId: string | null; basisPoints: number; validFrom: string; validTo: string | null; status: string }

/** Overlapping ACTIVE rules for one target are impossible: a partial unique index allows one ACTIVE rule per scope and target (ADR 0018), so there is no overlap check. */
export function auditMarkupRules(rules: readonly MarkupRuleInput[]): MarkupRuleAuditRow[] {
  return [...rules].sort((a, b) => a.scope.localeCompare(b.scope) || a.validFrom.localeCompare(b.validFrom) || a.id.localeCompare(b.id)).map((rule) => {
    const f = new Findings()
    if (rule.status === 'ACTIVE') {
      if (rule.basisPoints === 0) f.add('MARKUP_ZERO_PERCENT', 'WARN', 'An ACTIVE rule with 0% markup sells NET rates at cost.', 1)
      if (rule.basisPoints > MARKUP_VERY_HIGH_BASIS_POINTS) f.add('MARKUP_VERY_HIGH', 'WARN', `An ACTIVE rule above ${MARKUP_VERY_HIGH_BASIS_POINTS / 100}%; confirm it is intended.`, 1)
    }
    return { ...rule, findings: f.list }
  })
}

// ---- remediation -------------------------------------------------------------------------------------------------------------
const PRIORITY: Record<RateFindingCode, RemediationPriority | null> = {
  RATE_AMOUNT_ZERO: 'P0', RATE_CURRENCY_MISMATCH: 'P0', RATE_BASIS_UNVERIFIED: 'P0', NET_MARKUP_MISSING: 'P0', PLAN_CURRENCY_NOT_ENABLED: 'P0', PLAN_CONTRACT_CURRENCY_MISMATCH: 'P0', OCCUPANCY_EXCEEDS_ROOM: 'P0', PLAN_CONTRACT_NOT_ACTIVE: 'P0',
  NO_PRICED_NIGHTS: 'P1', CONTRACT_MARKET_RULE_INVALID: 'P1', DUPLICATE_PLAN_CODE: 'P1', DUPLICATE_LOGICAL_PLAN: 'P1', RATE_GAPS: 'P1', NO_SELLABLE_NIGHTS: 'P1', CONTRACT_EXPIRING: 'P1',
  RATE_MIXED_BASIS: 'P2', RATE_OUTSIDE_CONTRACT: 'P2', RATE_OTHER_OCCUPANCY: 'P2', AVAILABILITY_GAPS: 'P2', PLAN_CODE_FORMAT: 'P2', MARKUP_ZERO_PERCENT: 'P2', MARKUP_VERY_HIGH: 'P2',
  PLAN_NOT_LIVE: null, CONTRACT_MARKET_RESTRICTED: null,
}
const ACTION: Record<RateFindingCode, string> = {
  RATE_AMOUNT_ZERO: 'Confirm the contracted price with the supplier and correct the rate in Quick Update, or close the night.',
  RATE_CURRENCY_MISMATCH: 'Correct the rate currency to the plan currency, or move the nights to a plan priced in that currency.',
  RATE_BASIS_UNVERIFIED: 'Confirm with the contract whether the stored amounts are NET or SELL and record the basis.',
  NET_MARKUP_MISSING: 'Request an ACTIVE markup rule covering these nights (maker-checker approval), or confirm the rates are SELL.',
  PLAN_CURRENCY_NOT_ENABLED: 'Use an enabled settlement currency for the plan, or ask the owner to enable the currency by policy.',
  PLAN_CONTRACT_CURRENCY_MISMATCH: 'Align the plan currency with the contract settlement currency.',
  OCCUPANCY_EXCEEDS_ROOM: 'Fix the plan occupancy or the room maximum occupancy.',
  PLAN_CONTRACT_NOT_ACTIVE: 'Renew or reactivate the contract, or set the plan inactive.',
  NO_PRICED_NIGHTS: 'Load rates for the window, or set the plan inactive if it is not meant to sell.',
  DUPLICATE_PLAN_CODE: 'Decide which plan keeps the code and rename the other in a review (suggested codes are only suggestions).',
  DUPLICATE_LOGICAL_PLAN: 'Review the plans with a revenue manager; keep one and deactivate the other. Nothing is merged automatically.',
  RATE_GAPS: 'Load the missing nights or close them with stop-sell.',
  NO_SELLABLE_NIGHTS: 'Resolve the listed blockers (inventory, mapping, stop-sell) in the hotel workspace.',
  CONTRACT_MARKET_RULE_INVALID: 'Correct the contract sales-market and nationality lists to two-letter country codes (or clear them); nothing is rewritten automatically.',
  CONTRACT_EXPIRING: 'Renew the contract before it expires.',
  RATE_MIXED_BASIS: 'Confirm the NET/SELL mix with the contract.',
  RATE_OUTSIDE_CONTRACT: 'Review the dates; the rows are never sold and can be corrected or left.',
  RATE_OTHER_OCCUPANCY: 'These rows belong to another occupancy; load them on the matching plan or leave them.',
  AVAILABILITY_GAPS: 'Load availability for the listed nights or set stop-sell.',
  PLAN_CODE_FORMAT: 'Rename the plan to the governed pattern, if an administrator agrees; suggestion only.',
  MARKUP_ZERO_PERCENT: 'Confirm that selling at cost is intended.', MARKUP_VERY_HIGH: 'Confirm the percentage.',
  PLAN_NOT_LIVE: '', CONTRACT_MARKET_RESTRICTED: '',
}

export function remediationItems(plans: readonly RatePlanAuditRow[]): RemediationItem[] {
  const items: RemediationItem[] = []
  for (const plan of plans) {
    if (!plan.live) continue
    for (const finding of plan.findings) {
      const priority = PRIORITY[finding.code]
      if (!priority || finding.severity === 'INFO') continue
      items.push({ id: `${plan.ratePlanId}|${finding.code}`, priority, hotelId: plan.hotelId, hotelName: plan.hotelName, ratePlanId: plan.ratePlanId, ratePlanCode: plan.code, code: finding.code, severity: finding.severity, message: finding.message, count: finding.count, suggestedAction: ACTION[finding.code] })
    }
  }
  const rank: Record<RemediationPriority, number> = { P0: 0, P1: 1, P2: 2 }
  return items.sort((a, b) => rank[a.priority] - rank[b.priority] || a.hotelName.localeCompare(b.hotelName) || (a.ratePlanCode ?? '').localeCompare(b.ratePlanCode ?? '') || a.code.localeCompare(b.code))
}

export function markupRemediation(rows: readonly MarkupRuleAuditRow[]): RemediationItem[] {
  const items: RemediationItem[] = []
  for (const rule of rows) for (const finding of rule.findings) {
    const priority = PRIORITY[finding.code]
    if (priority) items.push({ id: `${rule.id}|${finding.code}`, priority, hotelId: rule.hotelId ?? '', hotelName: rule.scope === 'HOTEL' ? 'Hotel markup rule' : rule.scope === 'SUPPLIER' ? 'Supplier markup rule' : 'Tenant default markup rule', ratePlanId: null, ratePlanCode: null, code: finding.code, severity: finding.severity, message: finding.message, count: finding.count, suggestedAction: ACTION[finding.code] })
  }
  return items
}

// ---- simulator ---------------------------------------------------------------------------------------------------------------
export interface SimulateInput {
  plan: AuditPlan
  mapping: { status: string; hotelId: string } | null
  roomMapping: { status: string } | null
  rules: readonly MarkupRuleRow[]
  dates: string[]
  checkIn: string
  checkOut: string
  adults: number
  children: number
  rooms: number
  now: Date
}

/**
 * Prices a stay through the same evaluator the Agent search uses, then recomputes the total from the stored rows independently
 * (rate plus half-up markup per night, times rooms) and reports whether the two agree. It writes nothing.
 */
export function simulateStay(input: SimulateInput): Omit<SimulationResult, 'generatedAt'> {
  const { plan } = input
  const own = { ...plan, dailyRates: plan.dailyRates.filter((r) => r.occupancy === plan.occupancy) }
  const resolver = markupResolverFor(input.rules, plan.contract.supplierId, plan.roomType.hotelId)
  const decision = evaluateContractedStay(buildStaySnapshot(own, input.mapping, input.roomMapping, input.dates, resolver), { checkIn: input.checkIn, checkOut: input.checkOut, rooms: input.rooms, adults: input.adults, children: input.children, currency: plan.currency, now: input.now })
  const rates = new Map(own.dailyRates.map((r) => [dayOf(r.stayDate), r]))
  let recomputed: bigint | null = 0n
  const nights: SimulatedNight[] = input.dates.map((date) => {
    const rate = rates.get(date)
    const basis = rate?.amountBasis === 'NET' || rate?.amountBasis === 'SELL' ? rate.amountBasis : null
    if (!rate || !basis || rate.amountMinor < 0n) { recomputed = null; return { date, rateMinor: rate ? rate.amountMinor.toString() : null, basis, markupBasisPoints: null, markupMinor: null, sellMinor: null } }
    if (basis === 'SELL') { if (recomputed !== null) recomputed += rate.amountMinor; return { date, rateMinor: rate.amountMinor.toString(), basis, markupBasisPoints: null, markupMinor: '0', sellMinor: rate.amountMinor.toString() } }
    const bp = resolveMarkupBasisPoints(input.rules, { supplierId: plan.contract.supplierId, hotelId: plan.roomType.hotelId }, date)
    if (bp === null) { recomputed = null; return { date, rateMinor: rate.amountMinor.toString(), basis, markupBasisPoints: null, markupMinor: null, sellMinor: null } }
    const markup = markupMinor(rate.amountMinor, bp)
    if (recomputed !== null) recomputed += rate.amountMinor + markup
    return { date, rateMinor: rate.amountMinor.toString(), basis, markupBasisPoints: bp, markupMinor: markup.toString(), sellMinor: (rate.amountMinor + markup).toString() }
  })
  const recomputedTotal = recomputed === null ? null : (recomputed as bigint) * BigInt(input.rooms)
  const eligible = decision.eligible
  return {
    ratePlanId: plan.id, ratePlanCode: plan.code, hotelId: plan.roomType.hotelId, currency: plan.currency, eligible, reasons: decision.reasons, nights,
    netMinor: eligible && decision.netMinor !== null ? decision.netMinor.toString() : null,
    markupMinor: eligible && decision.markupMinor !== null ? decision.markupMinor.toString() : null,
    totalMinor: eligible && decision.totalMinor !== null ? decision.totalMinor.toString() : null,
    recomputedTotalMinor: recomputedTotal === null ? null : recomputedTotal.toString(), rooms: input.rooms,
    reconciles: !eligible || (decision.totalMinor !== null && recomputedTotal !== null && decision.totalMinor === recomputedTotal),
  }
}

