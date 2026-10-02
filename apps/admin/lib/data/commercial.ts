// Commercial markup rules API (ADR 0018). Authoritative: rates are priced by the API, never in the browser.
import { routes, type MarkupImpact, type MarkupActivationRequest, type MarkupActivationResult, type MarkupRuleCreate, type MarkupRulePage, type MarkupRuleView } from '@bedbanks/contracts'
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
export const decideMarkupApproval = (approvalId: string, decision: 'approve' | 'reject', reason: string) =>
  apiRequestWithMeta<MarkupRuleView>(fill(decision === 'approve' ? c.markupApprovalApprove : c.markupApprovalReject, { approvalId }), { method: 'POST', headers: json, body: JSON.stringify({ reason }) })
export const cancelMarkupApproval = (approvalId: string) => apiRequestWithMeta<MarkupRuleView>(fill(c.markupApprovalCancel, { approvalId }), { method: 'POST', headers: json, body: '{}' })
export const executeMarkupApproval = (approvalId: string) => apiRequestWithMeta<MarkupActivationResult>(fill(c.markupApprovalExecute, { approvalId }), { method: 'POST', headers: json, body: '{}' })
export const getMarkupImpact = (p: Params = {}) => apiRequest<MarkupImpact>(`${routes.adminOperations.commercialImpact}${opsQuery(p)}`)
