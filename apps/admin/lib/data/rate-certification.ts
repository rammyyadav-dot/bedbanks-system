// Rate plan audit and certification API access (ADR 0033). Read-only: the simulator is a POST that prices a stay and writes nothing.
import {
  routes, type HotelCertificationPage, type MarkupRuleAudit, type RateCertificationPlansPage, type RateCertificationReport, type RateCertificationSummary,
  type RatePlanAuditDetail, type RemediationQueue, type SimulateRequest, type SimulationResult,
} from '@bedbanks/contracts'
import { apiRequest } from '../api/client'
import { opsQuery } from '../ops-state'

type Params = Record<string, string | number | boolean | undefined | null>
const r = routes.adminRateCertification
const json = { 'Content-Type': 'application/json' }
const fill = (path: string, values: Record<string, string>) => Object.entries(values).reduce((p, [k, v]) => p.replace(`:${k}`, encodeURIComponent(v)), path)

export const getRateCertificationSummary = (p: Params = {}) => apiRequest<RateCertificationSummary>(`${r.summary}${opsQuery(p)}`)
export const getRateCertificationPlans = (p: Params) => apiRequest<RateCertificationPlansPage>(`${r.plans}${opsQuery(p)}`)
export const getRateCertificationPlan = (ratePlanId: string, p: Params = {}) => apiRequest<RatePlanAuditDetail>(`${fill(r.plan, { ratePlanId })}${opsQuery(p)}`)
export const getRateCertificationHotels = (p: Params) => apiRequest<HotelCertificationPage>(`${r.hotels}${opsQuery(p)}`)
export const getRateCertificationMarkupRules = () => apiRequest<MarkupRuleAudit>(r.markupRules)
export const getRateCertificationRemediation = (p: Params) => apiRequest<RemediationQueue>(`${r.remediation}${opsQuery(p)}`)
export const getRateCertificationReport = (p: Params) => apiRequest<RateCertificationReport>(`${r.report}${opsQuery(p)}`)
export const simulateRateStay = (body: SimulateRequest) => apiRequest<SimulationResult>(r.simulate, { method: 'POST', headers: json, body: JSON.stringify(body) })
