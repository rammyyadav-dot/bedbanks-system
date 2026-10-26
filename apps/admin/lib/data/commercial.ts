// Commercial markup rules API (ADR 0018). Authoritative: rates are priced by the API, never in the browser.
import { routes, STEP_UP_FIELD, type FxActivationResult, type FxRateCreate, type FxRatePage, type FxRateView, type MarkupImpact, type MarkupActivationRequest, type MarkupActivationResult, type MarkupRuleCreate, type MarkupRulePage, type MarkupRuleView } from '@bedbanks/contracts'
import { apiRequest, apiRequestWithMeta } from '../api/client'
import { opsQuery } from '../ops-state'

type Params = Record<string, string | number | boolean | undefined | null>
const c = routes.adminCommercial
const json = { 'Content-Type': 'application/json' }
const fill = (path: string, values: Record<string, string>) => Object.entries(values).reduce((p, [k, v]) => p.replace(`:${k}`, encodeURIComponent(v)), path)

export const getMarkupRules = (p: Params = {}) => apiRequest<MarkupRulePage>(`${c.markups}${opsQuery(p)}`)
export const createMarkupRule = (body: MarkupRuleCreate) => apiRequestWithMeta<MarkupRuleView>(c.markups, { method: 'POST', headers: json, body: JSON.stringify(body) })
export const retireMarkupRule = (ruleId: string) => apiRequestWithMeta<MarkupRuleView>(fill(c.markupRetire, { ruleId }), { method: 'POST', headers: json, body: '{}' })
export const requestMarkupActivation = (ruleId: string, body: MarkupActivationRequest) => apiRequestWithMeta<MarkupRuleView>(fill(c.markupRequestActivation, { ruleId }), { method: 'POST', headers: json, body: JSON.stringify(body) })
/** Approving needs the checker's own password (ADR 0095); rejecting does not. */
export const decideMarkupApproval = (approvalId: string, decision: 'approve' | 'reject', reason: string, stepUpPassword?: string) =>
  apiRequestWithMeta<MarkupRuleView>(fill(decision === 'approve' ? c.markupApprovalApprove : c.markupApprovalReject, { approvalId }), { method: 'POST', headers: json, body: JSON.stringify(decision === 'approve' ? { reason, [STEP_UP_FIELD]: stepUpPassword } : { reason }) })
export const cancelMarkupApproval = (approvalId: string) => apiRequestWithMeta<MarkupRuleView>(fill(c.markupApprovalCancel, { approvalId }), { method: 'POST', headers: json, body: '{}' })
export const executeMarkupApproval = (approvalId: string) => apiRequestWithMeta<MarkupActivationResult>(fill(c.markupApprovalExecute, { approvalId }), { method: 'POST', headers: json, body: '{}' })
export const getMarkupImpact = (p: Params = {}) => apiRequest<MarkupImpact>(`${routes.adminOperations.commercialImpact}${opsQuery(p)}`)

// Controlled FX rates (ADR 0067 F-12): the same maker-checker lifecycle as markup rules. The browser never converts a price.
export const getFxRates = (p: Params = {}) => apiRequest<FxRatePage>(`${c.fxRates}${opsQuery(p)}`)
export const createFxRate = (body: FxRateCreate) => apiRequestWithMeta<FxRateView>(c.fxRates, { method: 'POST', headers: json, body: JSON.stringify(body) })
export const retireFxRate = (rateId: string) => apiRequestWithMeta<FxRateView>(fill(c.fxRateRetire, { rateId }), { method: 'POST', headers: json, body: '{}' })
export const requestFxActivation = (rateId: string, body: MarkupActivationRequest) => apiRequestWithMeta<FxRateView>(fill(c.fxRateRequestActivation, { rateId }), { method: 'POST', headers: json, body: JSON.stringify(body) })
export const decideFxApproval = (approvalId: string, decision: 'approve' | 'reject', reason: string, stepUpPassword?: string) =>
  apiRequestWithMeta<FxRateView>(fill(decision === 'approve' ? c.fxApprovalApprove : c.fxApprovalReject, { approvalId }), { method: 'POST', headers: json, body: JSON.stringify(decision === 'approve' ? { reason, [STEP_UP_FIELD]: stepUpPassword } : { reason }) })
export const cancelFxApproval = (approvalId: string) => apiRequestWithMeta<FxRateView>(fill(c.fxApprovalCancel, { approvalId }), { method: 'POST', headers: json, body: '{}' })
export const executeFxApproval = (approvalId: string) => apiRequestWithMeta<FxActivationResult>(fill(c.fxApprovalExecute, { approvalId }), { method: 'POST', headers: json, body: '{}' })
