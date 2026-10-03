// Clients, Service and Distribution API access (ADR 0019). Record-keeping and exposure control: no money, no pricing.
import {
  routes, type AgencyCreate, type AgencyCreditLimitRequest, type AgencyCreditResult, type AgencyMemberCandidate, type AgencyMemberView, type AgencyPage, type AgencySuspensionRequest, type AgencySuspensionResult, type AgencyUpdate, type AgencyView, type CaseAssign, type CaseAssignee, type CaseCreate,
  type CaseDetail, type CasePage, type CaseTransition, type ClientsSummary, type DistributionSummary, type RestrictionCreate, type RestrictionPage, type RestrictionView, type ServiceSummary,
} from '@bedbanks/contracts'
import { apiRequest, apiRequestWithMeta } from '../api/client'
import { opsQuery } from '../ops-state'

type Params = Record<string, string | number | boolean | undefined | null>
const c = routes.adminClients; const s = routes.adminService; const d = routes.adminDistribution
const json = { 'Content-Type': 'application/json' }
const fill = (path: string, values: Record<string, string>) => Object.entries(values).reduce((p, [k, v]) => p.replace(`:${k}`, encodeURIComponent(v)), path)
const post = (body?: unknown) => ({ method: 'POST', headers: json, body: JSON.stringify(body ?? {}) })

// ---- Clients
export const getClientsSummary = () => apiRequest<ClientsSummary>(c.summary)
export const getAgencies = (p: Params = {}) => apiRequest<AgencyPage>(`${c.agencies}${opsQuery(p)}`)
export const createAgency = (body: AgencyCreate) => apiRequestWithMeta<AgencyView>(c.agencies, post(body))
export const updateAgency = (agencyId: string, body: AgencyUpdate) => apiRequestWithMeta<AgencyView>(fill(c.agency, { agencyId }), { method: 'PATCH', headers: json, body: JSON.stringify(body) })
export const getAgencyMembers = (agencyId: string) => apiRequest<AgencyMemberView[]>(fill(c.agencyMembers, { agencyId }))
export const getMemberCandidates = (p: Params = {}) => apiRequest<AgencyMemberCandidate[]>(`${c.memberCandidates}${opsQuery(p)}`)
export const addAgencyMember = (agencyId: string, userId: string) => apiRequestWithMeta<AgencyMemberView[]>(fill(c.agencyMembers, { agencyId }), post({ userId }))
export const removeAgencyMember = (agencyId: string, userId: string) => apiRequestWithMeta<AgencyMemberView[]>(fill(c.agencyMember, { agencyId, userId }), { method: 'DELETE' })

// ---- Service
export const getServiceSummary = () => apiRequest<ServiceSummary>(s.summary)
export const getCases = (p: Params = {}) => apiRequest<CasePage>(`${s.cases}${opsQuery(p)}`)
export const getCase = (caseId: string) => apiRequest<CaseDetail>(fill(s.case, { caseId }))
export const getCaseAssignees = () => apiRequest<CaseAssignee[]>(s.assignees)
export const createCase = (body: CaseCreate) => apiRequestWithMeta<CaseDetail>(s.cases, post(body))
export const transitionCase = (caseId: string, body: CaseTransition) => apiRequestWithMeta<CaseDetail>(fill(s.caseTransition, { caseId }), post(body))
export const assignCase = (caseId: string, body: CaseAssign) => apiRequestWithMeta<CaseDetail>(fill(s.caseAssign, { caseId }), post(body))
export const addCaseNote = (caseId: string, body: string) => apiRequestWithMeta<CaseDetail>(fill(s.caseNotes, { caseId }), post({ body }))

// ---- Distribution
export const getDistributionSummary = () => apiRequest<DistributionSummary>(d.summary)
export const getRestrictions = (p: Params = {}) => apiRequest<RestrictionPage>(`${d.restrictions}${opsQuery(p)}`)
export const createRestriction = (body: RestrictionCreate) => apiRequestWithMeta<RestrictionView>(d.restrictions, post(body))
export const retireRestriction = (restrictionId: string) => apiRequestWithMeta<RestrictionView>(fill(d.restrictionRetire, { restrictionId }), post())

// ---- Agency suspension (ADR 0020): maker-checker
export const requestAgencySuspensionChange = (agencyId: string, body: AgencySuspensionRequest) => apiRequestWithMeta<AgencyView>(fill(c.agencySuspensionRequest, { agencyId }), post(body))
export const decideAgencySuspension = (approvalId: string, decision: 'approve' | 'reject', reason: string) =>
  apiRequestWithMeta<AgencyView>(fill(decision === 'approve' ? c.agencySuspensionApprove : c.agencySuspensionReject, { approvalId }), post({ reason }))
export const cancelAgencySuspension = (approvalId: string) => apiRequestWithMeta<AgencyView>(fill(c.agencySuspensionCancel, { approvalId }), post())
export const executeAgencySuspension = (approvalId: string) => apiRequestWithMeta<AgencySuspensionResult>(fill(c.agencySuspensionExecute, { approvalId }), post())

// ---- Agency credit limit (ADR 0024): maker-checker, enforced when a hold is placed
export const getAgency = (agencyId: string) => apiRequest<AgencyView>(fill(c.agency, { agencyId }))
export const requestAgencyCreditLimit = (agencyId: string, body: AgencyCreditLimitRequest) => apiRequestWithMeta<AgencyView>(fill(c.agencyCreditRequest, { agencyId }), post(body))
export const decideAgencyCredit = (approvalId: string, decision: 'approve' | 'reject', reason: string) =>
  apiRequestWithMeta<AgencyView>(fill(decision === 'approve' ? c.agencyCreditApprove : c.agencyCreditReject, { approvalId }), post({ reason }))
export const cancelAgencyCredit = (approvalId: string) => apiRequestWithMeta<AgencyView>(fill(c.agencyCreditCancel, { approvalId }), post())
export const executeAgencyCredit = (approvalId: string) => apiRequestWithMeta<AgencyCreditResult>(fill(c.agencyCreditExecute, { approvalId }), post())
