import type { ContractAmendmentChanges, ContractAmendmentInputChanges, ContractApprovalView, ContractHeaderTerms, ContractTermsView } from '@bedbanks/contracts'

/**
 * What the contract page shows for the contract lifecycle (ADR 0067). Display only: the API enforces who may decide, the term binding
 * and every readiness rule; the flags used here come from the server for the signed-in user.
 */
export type ContractStage = 'none' | 'awaiting-other' | 'decide' | 'execute'

export function contractStage(open: ContractApprovalView | null): ContractStage {
  if (!open) return 'none'
  if (open.status === 'APPROVED' && open.canExecute) return 'execute'
  if (open.status === 'PENDING') return open.canDecide ? 'decide' : 'awaiting-other'
  return 'none'
}

export const CONTRACT_STAGE_TITLE: Record<ContractStage, string> = {
  none: 'No open request',
  'awaiting-other': 'Waiting for a second approver',
  decide: 'Review and decide',
  execute: 'Approved: apply now',
}

/** Header terms the contract form edits, in the shape an amendment sends. */
export interface HeaderForm extends ContractHeaderTerms { code: string; validFrom: string; validTo: string; settlementCurrency: string; salesMarkets: string[]; nationalities: string[] }

export const HEADER_TERM_KEYS = ['rateType', 'commissionBp', 'paymentTermsDays', 'signedAt', 'signedDocumentRef', 'allotmentType', 'minStayMode', 'clientBufferDays'] as const satisfies ReadonlyArray<keyof ContractHeaderTerms>

/** Header terms as the contract record returns them (dates as ISO instants), with the API defaults for a record that predates them. */
export function headerTermsOf(c: Partial<Record<keyof ContractHeaderTerms, unknown>>): ContractHeaderTerms {
  return {
    rateType: (c.rateType as ContractHeaderTerms['rateType']) ?? null, commissionBp: (c.commissionBp as number | null) ?? null, paymentTermsDays: (c.paymentTermsDays as number | null) ?? null,
    signedAt: typeof c.signedAt === 'string' ? c.signedAt.slice(0, 10) : null, signedDocumentRef: (c.signedDocumentRef as string | null) ?? null,
    allotmentType: (c.allotmentType as ContractHeaderTerms['allotmentType']) ?? null, minStayMode: c.minStayMode === 'ARRIVAL' ? 'ARRIVAL' : 'STAY_THROUGH', clientBufferDays: typeof c.clientBufferDays === 'number' ? c.clientBufferDays : 0,
  }
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i])

/** The header changes between the live terms and the form: only what differs is sent, so the approver reviews exactly the change. */
export function headerAmendment(current: HeaderForm, form: HeaderForm): ContractAmendmentInputChanges {
  const out: ContractAmendmentInputChanges = {}
  if (form.code.trim() !== current.code) out.code = form.code.trim()
  if (form.validFrom !== current.validFrom) out.validFrom = form.validFrom
  if (form.validTo !== current.validTo) out.validTo = form.validTo
  if (form.settlementCurrency.toUpperCase() !== current.settlementCurrency) out.settlementCurrency = form.settlementCurrency.toUpperCase()
  if (!sameList(form.salesMarkets, current.salesMarkets)) out.salesMarkets = form.salesMarkets
  if (!sameList(form.nationalities, current.nationalities)) out.nationalities = form.nationalities
  for (const k of HEADER_TERM_KEYS) if (form[k] !== current[k]) (out as Record<string, unknown>)[k] = form[k]
  return out
}

type TermKey = Exclude<keyof ContractAmendmentChanges, 'header'> | keyof ContractHeaderTerms
const TERM_LABEL: Record<TermKey, string> = {
  rateType: 'Rate type', commissionBp: 'Commission (basis points)', paymentTermsDays: 'Payment terms (days)', signedAt: 'Signed on', signedDocumentRef: 'Signed document',
  allotmentType: 'Allotment type', minStayMode: 'Minimum stay reading', clientBufferDays: 'Client cancellation buffer (days)',
  code: 'Code', validFrom: 'Valid from', validTo: 'Valid to', settlementCurrency: 'Settlement currency', salesMarkets: 'Sales markets', nationalities: 'Nationalities',
  paymentPolicyRef: 'Payment terms', cancellationPolicies: 'Cancellation rules', childPolicies: 'Child policy', leadTimeRule: 'Booking lead time', supplements: 'Supplements',
}

/** One line per changed term, for the approver. Policy sets are summarised by count; the full set is in the request. */
export function describeChanges(raw: ContractAmendmentChanges | ContractAmendmentInputChanges | null, prior?: Partial<ContractTermsView> & Partial<ContractHeaderTerms>): string[] {
  if (!raw) return []
  // Stored amendments nest the header terms; staged ones send them top-level. Both read the same to the approver.
  const { header, ...rest } = raw as ContractAmendmentChanges
  const changes = { ...rest, ...(header ?? {}) } as Record<TermKey, unknown>
  const before = prior ? ({ ...prior, ...(prior.header ?? {}) } as Partial<Record<TermKey, unknown>>) : undefined
  return (Object.keys(changes) as TermKey[]).map((key) => {
    const value = changes[key]
    const shown = Array.isArray(value) ? (key === 'salesMarkets' || key === 'nationalities' ? (value.length ? value.join(', ') : 'none') : `${value.length} rule(s)`) : value === null ? 'none' : typeof value === 'object' ? JSON.stringify(value) : String(value)
    const was = before?.[key]
    const prior = was === undefined ? '' : Array.isArray(was) ? (key === 'salesMarkets' || key === 'nationalities' ? ` (was ${was.length ? was.join(', ') : 'none'})` : ` (was ${was.length} rule(s))`) : ` (was ${was === null ? 'none' : typeof was === 'object' ? JSON.stringify(was) : String(was)})`
    return `${TERM_LABEL[key]}: ${shown}${prior}`
  })
}

/** "12.5" -> 1250 basis points, by string arithmetic (no floats). Empty -> null. Anything else -> undefined. */
export function percentToBp(text: string): number | null | undefined {
  const t = text.trim()
  if (t === '') return null
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(t)
  if (!m) return undefined
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
}
export const bpToPercent = (bp: number | null): string => (bp === null ? '' : `${Math.trunc(bp / 100)}${bp % 100 ? `.${String(bp % 100).padStart(2, '0').replace(/0$/, '')}` : ''}`)

export const newContractRequestId = (random: () => string = () => globalThis.crypto.randomUUID()): string => `contract-${random()}`
