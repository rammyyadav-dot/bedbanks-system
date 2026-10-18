import { createHash } from 'node:crypto'
import { isValidPolicySetName, rulesForPlan } from './cancellation-rules'
import { parseMarketList } from './market-rules'

/**
 * Contract lifecycle, maker-checker and versioning (ADR 0067, finding F-01). Pure: no I/O, no clock (`today` is injected).
 *
 * Status moves:
 *  - DRAFT -> REVIEW (submit) and REVIEW -> DRAFT (return) are single-actor housekeeping.
 *  - DRAFT | REVIEW | SUSPENDED -> ACTIVE only through an approved, single-use `contract.approve` request bound to the exact terms reviewed.
 *  - ACTIVE -> SUSPENDED is single-actor: stopping sales is always allowed and is the safe direction.
 *  - EXPIRED is terminal.
 * While a contract is ACTIVE or EXPIRED its commercial terms (header and policies) are locked. An ACTIVE contract changes only through an
 * approved amendment, which applies the reviewed terms, raises `version` by one and records an immutable snapshot.
 */
export type ContractStatusValue = 'DRAFT' | 'REVIEW' | 'ACTIVE' | 'EXPIRED' | 'SUSPENDED'
export const CONTRACT_EDITABLE_STATUSES: readonly ContractStatusValue[] = ['DRAFT', 'REVIEW', 'SUSPENDED']
export const termsEditable = (status: string): boolean => (CONTRACT_EDITABLE_STATUSES as readonly string[]).includes(status)

export type ContractLifecycleAction = 'submit' | 'return' | 'suspend'
/** Single-actor transitions. Activation is never one of them. */
export function lifecycleTarget(action: ContractLifecycleAction, from: string): ContractStatusValue | null {
  if (action === 'submit') return from === 'DRAFT' ? 'REVIEW' : null
  if (action === 'return') return from === 'REVIEW' ? 'DRAFT' : null
  return from === 'ACTIVE' ? 'SUSPENDED' : null
}
export const activationAllowedFrom = (status: string): boolean => status === 'DRAFT' || status === 'REVIEW' || status === 'SUSPENDED'

/** ADR 0067 F-10: `kind` NO_SHOW (days 0, at most one per set) and `penaltyNights` (1-30, exclusive with percent and amount). */
export interface CancellationTerm { policySet: string | null; kind: 'CANCELLATION' | 'NO_SHOW'; daysBeforeCheckin: number; penaltyPercent: number | null; penaltyMinor: string | null; penaltyNights: number | null; currency: string | null }
export interface ChildTerm { minAge: number; maxAge: number; extraBedAllowed: boolean; supplementMinor: string | null; currency: string | null }
export interface LeadTimeTerm { minLeadHours: number; maxLeadDays: number | null }

/** Every commercial term of a contract, as reviewed. Dates are YYYY-MM-DD; money is integer minor units as strings. */
export interface ContractTerms {
  code: string
  supplierId: string
  supplierHotelMappingId: string | null
  validFrom: string
  validTo: string
  settlementCurrency: string
  salesMarkets: string[]
  nationalities: string[]
  paymentPolicyRef: string | null
  cancellationPolicies: CancellationTerm[]
  childPolicies: ChildTerm[]
  leadTimeRule: LeadTimeTerm | null
  /** Commercial header (ADR 0067, F-20/F-15). Null means not recorded. */
  header: ContractHeader
}

/** Commercial header terms a hotel contract states (ADR 0067, F-20) and the minimum-stay reading (F-15). Part of the reviewed terms. */
export interface ContractHeader {
  rateType: 'NET' | 'COMMISSIONABLE' | null
  /** Basis points of the sell price the hotel pays as commission. Required for COMMISSIONABLE, absent otherwise. */
  commissionBp: number | null
  paymentTermsDays: number | null
  signedAt: string | null
  signedDocumentRef: string | null
  allotmentType: 'GUARANTEED' | 'NON_GUARANTEED' | 'FREE_SALE' | null
  minStayMode: 'STAY_THROUGH' | 'ARRIVAL'
  /** Days the buyer's cancellation tiers start before the hotel's (ADR 0067, F-10), 0-30. */
  clientBufferDays: number
}
/** The header columns of a contract row as reviewed terms. */
export const headerOf = (c: { rateType: ContractHeader['rateType']; commissionBp: number | null; paymentTermsDays: number | null; signedAt: Date | null; signedDocumentRef: string | null; allotmentType: ContractHeader['allotmentType']; minStayMode: ContractHeader['minStayMode']; clientBufferDays: number }): ContractHeader => ({
  rateType: c.rateType, commissionBp: c.commissionBp, paymentTermsDays: c.paymentTermsDays, signedAt: c.signedAt ? c.signedAt.toISOString().slice(0, 10) : null, signedDocumentRef: c.signedDocumentRef, allotmentType: c.allotmentType, minStayMode: c.minStayMode, clientBufferDays: c.clientBufferDays,
})
export const EMPTY_HEADER: ContractHeader = { rateType: null, commissionBp: null, paymentTermsDays: null, signedAt: null, signedDocumentRef: null, allotmentType: null, minStayMode: 'STAY_THROUGH', clientBufferDays: 0 }
export const HEADER_KEYS = ['rateType', 'commissionBp', 'paymentTermsDays', 'signedAt', 'signedDocumentRef', 'allotmentType', 'minStayMode', 'clientBufferDays'] as const
/** Governance fields: who owns the contract and when renewal is flagged. Not commercial terms, so editable while the contract is ACTIVE. */
export const GOVERNANCE_KEYS = ['ownerUserId', 'renewalReminderDays'] as const

/**
 * Validates header keys present in `raw` against the header they would replace. Missing keys keep `current`. Every problem is reported.
 * The combination is checked as a whole: COMMISSIONABLE needs a commission, NET takes none.
 */
export function normaliseHeader(raw: Record<string, unknown>, current: ContractHeader, errors: string[]): ContractHeader {
  const out: ContractHeader = { ...current }
  const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k)
  if (has('rateType')) { const v = raw.rateType; if (v === null || v === 'NET' || v === 'COMMISSIONABLE') out.rateType = v; else errors.push('rateType: NET, COMMISSIONABLE or null.') }
  if (has('commissionBp')) { const v = raw.commissionBp; if (v === null) out.commissionBp = null; else if (whole(v, 1, 5000)) out.commissionBp = v; else errors.push('commissionBp: a whole number of basis points from 1 to 5000 (1 basis point to 50 percent), or null.') }
  if (has('paymentTermsDays')) { const v = raw.paymentTermsDays; if (v === null) out.paymentTermsDays = null; else if (whole(v, 0, 365)) out.paymentTermsDays = v; else errors.push('paymentTermsDays: a whole number of days from 0 to 365, or null.') }
  if (has('signedAt')) { const v = raw.signedAt; if (v === null || v === '') out.signedAt = null; else if (isDay(v)) out.signedAt = v; else errors.push('signedAt: a real calendar day (YYYY-MM-DD), or null.') }
  if (has('signedDocumentRef')) { const v = raw.signedDocumentRef; if (v === null || v === '') out.signedDocumentRef = null; else if (typeof v === 'string' && v.trim().length <= 200 && !/[\u0000-\u001f]/.test(v)) out.signedDocumentRef = v.trim(); else errors.push('signedDocumentRef: up to 200 characters, or null.') }
  if (has('allotmentType')) { const v = raw.allotmentType; if (v === null || v === 'GUARANTEED' || v === 'NON_GUARANTEED' || v === 'FREE_SALE') out.allotmentType = v; else errors.push('allotmentType: GUARANTEED, NON_GUARANTEED, FREE_SALE or null.') }
  if (has('clientBufferDays')) { const v = raw.clientBufferDays; if (whole(v, 0, 30)) out.clientBufferDays = v; else errors.push('clientBufferDays: a whole number of days from 0 to 30.') }
  if (has('minStayMode')) { const v = raw.minStayMode; if (v === 'STAY_THROUGH' || v === 'ARRIVAL') out.minStayMode = v; else errors.push('minStayMode: STAY_THROUGH or ARRIVAL.') }
  if (out.rateType === 'COMMISSIONABLE' && out.commissionBp === null) errors.push('commissionBp: a commissionable contract needs its commission.')
  if (out.rateType !== 'COMMISSIONABLE' && out.commissionBp !== null) errors.push('commissionBp: only a commissionable contract carries a commission.')
  return out
}

const byCancellation = (a: CancellationTerm, b: CancellationTerm) => (a.policySet ?? '').localeCompare(b.policySet ?? '') || a.kind.localeCompare(b.kind) || (a.penaltyNights ?? -1) - (b.penaltyNights ?? -1) || b.daysBeforeCheckin - a.daysBeforeCheckin || (a.penaltyPercent ?? -1) - (b.penaltyPercent ?? -1) || (a.penaltyMinor ?? '').localeCompare(b.penaltyMinor ?? '')
const byChild = (a: ChildTerm, b: ChildTerm) => a.minAge - b.minAge || a.maxAge - b.maxAge

/** Canonical form: policies sorted, lists sorted, so the same terms always give the same fingerprint whatever order the rows came in. */
export function canonicalTerms(terms: ContractTerms): ContractTerms {
  return {
    ...terms,
    salesMarkets: [...terms.salesMarkets].sort(), nationalities: [...terms.nationalities].sort(),
    cancellationPolicies: [...terms.cancellationPolicies].sort(byCancellation), childPolicies: [...terms.childPolicies].sort(byChild),
  }
}

/** SHA-256 of the canonical terms. An approval is bound to it; any change to header or policies after the request invalidates the approval. */
export function termsFingerprint(terms: ContractTerms): string {
  const c = canonicalTerms(terms)
  const ordered = {
    code: c.code, supplierId: c.supplierId, supplierHotelMappingId: c.supplierHotelMappingId, validFrom: c.validFrom, validTo: c.validTo,
    settlementCurrency: c.settlementCurrency, salesMarkets: c.salesMarkets, nationalities: c.nationalities, paymentPolicyRef: c.paymentPolicyRef,
    cancellationPolicies: c.cancellationPolicies.map((p) => [p.policySet, p.kind, p.daysBeforeCheckin, p.penaltyPercent, p.penaltyMinor, p.penaltyNights, p.currency]),
    childPolicies: c.childPolicies.map((p) => [p.minAge, p.maxAge, p.extraBedAllowed, p.supplementMinor, p.currency]),
    leadTimeRule: c.leadTimeRule ? [c.leadTimeRule.minLeadHours, c.leadTimeRule.maxLeadDays] : null,
    header: HEADER_KEYS.map((k) => c.header[k]),
  }
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
}

export interface ContractCheck { code: string; label: string; ok: boolean; message: string }
export interface ContractActivationReadiness { ready: boolean; checks: ContractCheck[] }

/** The plans that hang off a contract, as far as the contract's own terms can break them. */
export interface PlanFacts { code: string; status: string; currency: string; refundable: boolean; cancellationPolicySet: string | null; validFrom: string | null; validTo: string | null }

export interface ContractActivationFacts {
  today: string
  status: string
  terms: ContractTerms
  supplierStatus: string
  /** Null when the contract is not bound to a hotel mapping. */
  mappingStatus: string | null
  plans: PlanFacts[]
}

const check = (code: string, label: string, ok: boolean, pass: string, fail: string): ContractCheck => ({ code, label, ok, message: ok ? pass : fail })

/** Problems the terms themselves cause for the plans under them. Used by activation and by amendment, so both refuse the same things. */
export function planConflicts(terms: ContractTerms, plans: readonly PlanFacts[]): string[] {
  const live = plans.filter((p) => p.status !== 'EXPIRED')
  const problems: string[] = []
  const currency = live.filter((p) => p.currency !== terms.settlementCurrency)
  if (currency.length) problems.push(`${currency.length} rate plan(s) are priced in another currency than ${terms.settlementCurrency}, first ${currency[0]!.code}.`)
  const outside = live.filter((p) => (p.validFrom !== null && p.validFrom < terms.validFrom) || (p.validTo !== null && p.validTo > terms.validTo))
  if (outside.length) problems.push(`${outside.length} rate plan sale window(s) fall outside ${terms.validFrom} to ${terms.validTo}, first ${outside[0]!.code}.`)
  const missingSet = live.filter((p) => p.refundable && p.cancellationPolicySet !== null && rulesForPlan(p, terms.cancellationPolicies).missing)
  if (missingSet.length) problems.push(`${missingSet.length} rate plan(s) name a cancellation set the contract would no longer have, first ${missingSet[0]!.code} ("${missingSet[0]!.cancellationPolicySet}").`)
  return problems
}

export function assessContractActivation(facts: ContractActivationFacts): ContractActivationReadiness {
  const { terms, today } = facts
  const checks: ContractCheck[] = []
  checks.push(check('STATUS_ALLOWED', 'Lifecycle state', activationAllowedFrom(facts.status), `Contract is ${facts.status}.`,
    facts.status === 'ACTIVE' ? 'Contract is already active.' : 'An expired contract cannot be reactivated; create a new contract.'))
  checks.push(check('VALIDITY', 'Validity', terms.validFrom <= terms.validTo && terms.validTo >= today, `Valid ${terms.validFrom} to ${terms.validTo}.`,
    terms.validFrom > terms.validTo ? 'The validity dates are inverted.' : `The contract ended on ${terms.validTo}.`))
  checks.push(check('SUPPLIER_ACTIVE', 'Supplier', facts.supplierStatus === 'ACTIVE', 'Supplier is active.', `Supplier is ${facts.supplierStatus}; only an active supplier can back an active contract.`))
  checks.push(check('MAPPING_APPROVED', 'Hotel mapping', facts.mappingStatus === null || facts.mappingStatus === 'MAPPED',
    facts.mappingStatus === null ? 'Contract is not bound to a hotel mapping.' : 'Hotel mapping is approved.', `The hotel mapping is ${facts.mappingStatus}; approve it first.`))
  checks.push(check('CURRENCY', 'Settlement currency', /^[A-Z]{3}$/.test(terms.settlementCurrency), `Settles in ${terms.settlementCurrency}.`, 'The settlement currency is not a 3-letter ISO-4217 code.'))
  const problems = planConflicts(terms, facts.plans)
  checks.push(check('PLANS_CONSISTENT', 'Rate plans under this contract', problems.length === 0,
    facts.plans.length === 0 ? 'No rate plan yet.' : `${facts.plans.length} rate plan(s) fit the terms.`, problems.join(' ')))
  return { ready: checks.every((c) => c.ok), checks }
}

// ---- amendments -------------------------------------------------------------------------------------------------------------------------

/** What an amendment may change. Supplier and hotel binding are identity: changing them is a new contract, never an amendment. */
export const AMENDABLE_KEYS = ['code', 'validFrom', 'validTo', 'settlementCurrency', 'salesMarkets', 'nationalities', 'paymentPolicyRef', 'cancellationPolicies', 'childPolicies', 'leadTimeRule', ...HEADER_KEYS] as const
export type AmendableKey = (typeof AMENDABLE_KEYS)[number]
export type ContractAmendment = Partial<Pick<ContractTerms, Exclude<AmendableKey, (typeof HEADER_KEYS)[number]>>> & { header?: Partial<ContractHeader> }

const DAY = /^\d{4}-\d{2}-\d{2}$/
const isDay = (v: unknown): v is string => typeof v === 'string' && DAY.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v
const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
const minorText = (v: unknown): string | null => (typeof v === 'string' && /^(0|[1-9][0-9]{0,17})$/.test(v) ? v : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : null)
const currencyOf = (v: unknown): string | null | undefined => (v === undefined || v === null ? null : typeof v === 'string' && /^[A-Za-z]{3}$/.test(v.trim()) ? v.trim().toUpperCase() : undefined)

/** Validates one cancellation rule as the create endpoint does. Returns the normalized rule, or pushes problems. */
export function cancellationTerm(raw: unknown, at: string, errors: string[]): CancellationTerm | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const hasPercent = r.penaltyPercent !== undefined && r.penaltyPercent !== null
  const hasMinor = r.penaltyMinor !== undefined && r.penaltyMinor !== null
  const hasNights = r.penaltyNights !== undefined && r.penaltyNights !== null
  const kind = r.kind === undefined || r.kind === null ? 'CANCELLATION' : r.kind
  if (kind !== 'CANCELLATION' && kind !== 'NO_SHOW') errors.push(`${at}: kind must be CANCELLATION or NO_SHOW.`)
  if (!whole(r.daysBeforeCheckin, 0, 3650)) errors.push(`${at}: daysBeforeCheckin must be a whole number of days, 0 or more.`)
  else if (kind === 'NO_SHOW' && r.daysBeforeCheckin !== 0) errors.push(`${at}: a no-show rule applies on arrival; daysBeforeCheckin must be 0.`)
  if (Number(hasPercent) + Number(hasMinor) + Number(hasNights) !== 1) errors.push(`${at}: give exactly one of penaltyPercent, penaltyMinor or penaltyNights.`)
  if (hasPercent && !whole(r.penaltyPercent, 0, 100)) errors.push(`${at}: penaltyPercent must be a whole number from 0 to 100.`)
  if (hasNights && !whole(r.penaltyNights, 1, 30)) errors.push(`${at}: penaltyNights must be a whole number of nights from 1 to 30.`)
  const minor = hasMinor ? minorText(r.penaltyMinor) : null
  if (hasMinor && minor === null) errors.push(`${at}: penaltyMinor must be a whole number of minor units, 0 or more.`)
  const currency = currencyOf(r.currency)
  if (currency === undefined) errors.push(`${at}: currency must be a 3-letter ISO-4217 code.`)
  const set = r.policySet === undefined || r.policySet === null || r.policySet === '' ? null : r.policySet
  if (set !== null && !isValidPolicySetName(set)) errors.push(`${at}: policySet must be 1-80 characters: letters, digits, space, dot, dash or underscore.`)
  return { policySet: set as string | null, kind: kind as CancellationTerm['kind'], daysBeforeCheckin: r.daysBeforeCheckin as number, penaltyPercent: hasPercent ? (r.penaltyPercent as number) : null, penaltyMinor: minor, penaltyNights: hasNights ? (r.penaltyNights as number) : null, currency: currency ?? null }
}

/** Sets that hold more than one no-show rule (ADR 0067, F-10). The default set is reported as "default". */
export function duplicateNoShowSets(rules: readonly Pick<CancellationTerm, 'policySet' | 'kind'>[]): string[] {
  const seen = new Map<string, number>()
  for (const r of rules) if (r.kind === 'NO_SHOW') seen.set(r.policySet ?? 'default', (seen.get(r.policySet ?? 'default') ?? 0) + 1)
  return [...seen].filter(([, n]) => n > 1).map(([set]) => set)
}

export function childTerm(raw: unknown, at: string, errors: string[]): ChildTerm | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (!whole(r.minAge, 0, 17) || !whole(r.maxAge, 0, 17) || (r.maxAge as number) < (r.minAge as number)) errors.push(`${at}: ages must be whole numbers 0 to 17 with the maximum not below the minimum.`)
  const hasMinor = r.supplementMinor !== undefined && r.supplementMinor !== null
  const minor = hasMinor ? minorText(r.supplementMinor) : null
  if (hasMinor && minor === null) errors.push(`${at}: supplementMinor must be a whole number of minor units, 0 or more.`)
  const currency = currencyOf(r.currency)
  if (currency === undefined) errors.push(`${at}: currency must be a 3-letter ISO-4217 code.`)
  if (r.extraBedAllowed !== undefined && typeof r.extraBedAllowed !== 'boolean') errors.push(`${at}: extraBedAllowed must be true or false.`)
  return { minAge: r.minAge as number, maxAge: r.maxAge as number, extraBedAllowed: r.extraBedAllowed === true, supplementMinor: minor, currency: currency ?? null }
}

/** Child bands must not overlap: a child matches exactly one. */
export function childOverlaps(terms: readonly ChildTerm[]): string | null {
  const sorted = [...terms].sort(byChild)
  for (let i = 1; i < sorted.length; i++) if (sorted[i]!.minAge <= sorted[i - 1]!.maxAge) return `Child bands ${sorted[i - 1]!.minAge}-${sorted[i - 1]!.maxAge} and ${sorted[i]!.minAge}-${sorted[i]!.maxAge} overlap.`
  return null
}

/** Validates an amendment body. Unknown keys and identity keys are refused, never ignored. */
export function normaliseAmendment(input: unknown): { changes?: ContractAmendment; errors: string[] } {
  const errors: string[] = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { errors: ['changes: an object of the terms to change is required.'] }
  // A stored amendment nests the header terms under `header` (the shape it is reviewed and applied in); a request sends them top-level.
  const { header: nested, ...flat } = input as Record<string, unknown>
  if (nested !== undefined && (!nested || typeof nested !== 'object' || Array.isArray(nested))) return { errors: ['header: an object of header terms.'] }
  const raw: Record<string, unknown> = { ...flat, ...(nested as Record<string, unknown> | undefined) }
  for (const key of Object.keys(raw)) {
    if (key === 'supplierId' || key === 'supplierHotelMappingId') errors.push(`${key}: the supplier and hotel binding identify a contract; create a new contract instead of amending them.`)
    else if (key === 'status') errors.push('status: an amendment never changes status. Use submit, activation, suspension.')
    else if (!(AMENDABLE_KEYS as readonly string[]).includes(key)) errors.push(`${key}: is not an amendable term.`)
  }
  if (Object.keys(raw).length === 0) errors.push('changes: name at least one term to change.')
  const out: ContractAmendment = {}
  if ('code' in raw) { const code = typeof raw.code === 'string' ? raw.code.trim() : ''; if (code.length < 1 || code.length > 80) errors.push('code: 1 to 80 characters.'); else out.code = code }
  for (const key of ['validFrom', 'validTo'] as const) if (key in raw) { if (!isDay(raw[key])) errors.push(`${key}: a real calendar day (YYYY-MM-DD).`); else out[key] = raw[key] as string }
  if ('settlementCurrency' in raw) { const c = currencyOf(raw.settlementCurrency); if (!c) errors.push('settlementCurrency: a 3-letter ISO-4217 code.'); else out.settlementCurrency = c }
  for (const key of ['salesMarkets', 'nationalities'] as const) if (key in raw) { const list = parseMarketList(raw[key]); if (list === null) errors.push(`${key}: a list of two-letter country codes.`); else out[key] = list }
  if ('paymentPolicyRef' in raw) { const v = raw.paymentPolicyRef; if (v === null || v === '') out.paymentPolicyRef = null; else if (typeof v === 'string' && v.trim().length <= 200) out.paymentPolicyRef = v.trim(); else errors.push('paymentPolicyRef: up to 200 characters, or null.') }
  if ('cancellationPolicies' in raw) {
    if (!Array.isArray(raw.cancellationPolicies) || raw.cancellationPolicies.length > 50) errors.push('cancellationPolicies: a list of at most 50 rules (the full replacement set).')
    else out.cancellationPolicies = raw.cancellationPolicies.map((r, i) => cancellationTerm(r, `cancellationPolicies[${i}]`, errors)!).filter(Boolean)
  }
  if ('childPolicies' in raw) {
    if (!Array.isArray(raw.childPolicies) || raw.childPolicies.length > 10) errors.push('childPolicies: a list of at most 10 bands (the full replacement set).')
    else { out.childPolicies = raw.childPolicies.map((r, i) => childTerm(r, `childPolicies[${i}]`, errors)!).filter(Boolean); const overlap = childOverlaps(out.childPolicies); if (overlap) errors.push(`childPolicies: ${overlap}`) }
  }
  const headerKeys = HEADER_KEYS.filter((k) => k in raw)
  if (headerKeys.length) {
    const partial: Record<string, unknown> = {}
    for (const k of headerKeys) partial[k] = raw[k]
    const before = errors.length
    // Field validation only here; the combination (commission with rate type) is checked against the full terms in amendmentProblems.
    const fieldErrors: string[] = []
    const parsed = normaliseHeader(partial, EMPTY_HEADER, fieldErrors)
    errors.push(...fieldErrors.filter((e) => !e.startsWith('commissionBp: a commissionable') && !e.startsWith('commissionBp: only')))
    if (errors.length === before) out.header = Object.fromEntries(headerKeys.map((k) => [k, parsed[k]])) as Partial<ContractHeader>
  }
  if ('leadTimeRule' in raw) {
    const v = raw.leadTimeRule
    if (v === null) out.leadTimeRule = null
    else { const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>; if (!whole(r.minLeadHours, 0, 8760) || (r.maxLeadDays != null && !whole(r.maxLeadDays, 0, 1095))) errors.push('leadTimeRule: minLeadHours 0 to 8760 and maxLeadDays 0 to 1095 or null.'); else out.leadTimeRule = { minLeadHours: r.minLeadHours as number, maxLeadDays: (r.maxLeadDays as number | null | undefined) ?? null } }
  }
  return errors.length ? { errors } : { changes: out, errors }
}

export function applyAmendment(terms: ContractTerms, changes: ContractAmendment): ContractTerms {
  const { header, ...rest } = changes
  return { ...terms, ...rest, header: header ? { ...terms.header, ...header } : terms.header }
}

/** Why an amendment cannot apply to these terms and plans. Empty when it can. */
export function amendmentProblems(before: ContractTerms, after: ContractTerms, plans: readonly PlanFacts[]): string[] {
  const problems: string[] = []
  if (termsFingerprint(before) === termsFingerprint(after)) problems.push('The amendment changes nothing.')
  if (after.validFrom > after.validTo) problems.push('The validity dates would be inverted.')
  const headerErrors: string[] = []
  normaliseHeader({}, after.header, headerErrors)
  problems.push(...headerErrors)
  for (const set of duplicateNoShowSets(after.cancellationPolicies)) problems.push(`Cancellation set ${set} has more than one no-show rule.`)
  for (const p of after.cancellationPolicies) if (p.currency !== null && p.currency !== after.settlementCurrency) { problems.push(`A cancellation rule is in ${p.currency}, not the settlement currency ${after.settlementCurrency}.`); break }
  for (const p of after.childPolicies) if (p.currency !== null && p.currency !== after.settlementCurrency) { problems.push(`A child band is in ${p.currency}, not the settlement currency ${after.settlementCurrency}.`); break }
  problems.push(...planConflicts(after, plans))
  return problems
}

/** The version the contract carries after an approved change: unchanged on a first activation, +1 when the reviewed terms differ from the last snapshot. */
export function nextVersion(current: number, lastSnapshot: { version: number; fingerprint: string } | null, fingerprint: string, kind: 'ACTIVATION' | 'AMENDMENT'): number {
  if (kind === 'AMENDMENT') return current + 1
  if (lastSnapshot === null) return current
  return lastSnapshot.fingerprint === fingerprint ? current : current + 1
}
