import type { ContractAmendmentChanges, ContractApprovalView, ContractTermsView } from '@bedbanks/contracts'

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
export interface HeaderForm { code: string; validFrom: string; validTo: string; settlementCurrency: string; salesMarkets: string[]; nationalities: string[] }

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i])

/** The header changes between the live terms and the form: only what differs is sent, so the approver reviews exactly the change. */
export function headerAmendment(current: HeaderForm, form: HeaderForm): ContractAmendmentChanges {
  const out: ContractAmendmentChanges = {}
  if (form.code.trim() !== current.code) out.code = form.code.trim()
  if (form.validFrom !== current.validFrom) out.validFrom = form.validFrom
  if (form.validTo !== current.validTo) out.validTo = form.validTo
  if (form.settlementCurrency.toUpperCase() !== current.settlementCurrency) out.settlementCurrency = form.settlementCurrency.toUpperCase()
  if (!sameList(form.salesMarkets, current.salesMarkets)) out.salesMarkets = form.salesMarkets
  if (!sameList(form.nationalities, current.nationalities)) out.nationalities = form.nationalities
  return out
}

const TERM_LABEL: Record<keyof ContractAmendmentChanges, string> = {
  code: 'Code', validFrom: 'Valid from', validTo: 'Valid to', settlementCurrency: 'Settlement currency', salesMarkets: 'Sales markets', nationalities: 'Nationalities',
  paymentPolicyRef: 'Payment terms', cancellationPolicies: 'Cancellation rules', childPolicies: 'Child policy', leadTimeRule: 'Booking lead time',
}

/** One line per changed term, for the approver. Policy sets are summarised by count; the full set is in the request. */
export function describeChanges(changes: ContractAmendmentChanges | null, before?: Partial<ContractTermsView>): string[] {
  if (!changes) return []
  return (Object.keys(changes) as Array<keyof ContractAmendmentChanges>).map((key) => {
    const value = changes[key]
    const shown = Array.isArray(value) ? (key === 'salesMarkets' || key === 'nationalities' ? (value.length ? value.join(', ') : 'none') : `${value.length} rule(s)`) : value === null ? 'none' : typeof value === 'object' ? JSON.stringify(value) : String(value)
    const was = before?.[key]
    const prior = was === undefined ? '' : Array.isArray(was) ? (key === 'salesMarkets' || key === 'nationalities' ? ` (was ${was.length ? was.join(', ') : 'none'})` : ` (was ${was.length} rule(s))`) : ` (was ${was === null ? 'none' : typeof was === 'object' ? JSON.stringify(was) : String(was)})`
    return `${TERM_LABEL[key]}: ${shown}${prior}`
  })
}

export const newContractRequestId = (random: () => string = () => globalThis.crypto.randomUUID()): string => `contract-${random()}`
