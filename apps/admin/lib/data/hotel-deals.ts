// Hotel deals and promotions API (ADR 0089). Authoritative: every price, guard and lifecycle rule lives in the API; the browser only shapes input and shows the answer.
import {
  routes, type HotelDealApprovalQueueItem, type HotelDealAuditTrail, type HotelDealCreateInput, type HotelDealDecisionInput, type HotelDealDetail, type HotelDealPage, type HotelDealPerformance,
  type HotelDealPreviewInput, type HotelDealPreviewResult, type HotelDealReconcileResult, type HotelDealReplaceInput, type HotelDealSubmitInput, type HotelDealSummary, type HotelDealTransitionInput, type HotelDealIssue,
} from '@bedbanks/contracts'
import { apiRequest } from '../api/client'
import { opsQuery } from '../ops-state'

type Params = Record<string, string | number | boolean | undefined | null>
const c = routes.adminCommercial
const json = { 'Content-Type': 'application/json' }
const fill = (path: string, values: Record<string, string>) => Object.entries(values).reduce((p, [k, v]) => p.replace(`:${k}`, encodeURIComponent(v)), path)
const post = <T>(path: string, body: object = {}) => apiRequest<T>(path, { method: 'POST', headers: json, body: JSON.stringify(body) })

export const getDeals = (p: Params = {}) => apiRequest<HotelDealPage>(`${c.promotions}${opsQuery(p)}`)
export const getDealSummary = (p: Params = {}) => apiRequest<HotelDealSummary>(`${c.promotionSummary}${opsQuery(p)}`)
export const getDealApprovalQueue = () => apiRequest<HotelDealApprovalQueueItem[]>(c.promotionApprovalQueue)
export const getDeal = (dealId: string) => apiRequest<HotelDealDetail>(fill(c.promotion, { dealId }))
export const createDeal = (body: HotelDealCreateInput) => post<HotelDealDetail>(c.promotions, body)
export const replaceDeal = (dealId: string, body: HotelDealReplaceInput) => apiRequest<HotelDealDetail>(fill(c.promotion, { dealId }), { method: 'PUT', headers: json, body: JSON.stringify(body) })
export const validateDeal = (dealId: string) => post<{ dealId: string; valid: boolean; issues: HotelDealIssue[] }>(fill(c.promotionValidate, { dealId }))
export const previewDeal = (dealId: string, body: HotelDealPreviewInput) => post<HotelDealPreviewResult>(fill(c.promotionPreview, { dealId }), body)
export const submitDeal = (dealId: string, body: HotelDealSubmitInput) => post<HotelDealDetail>(fill(c.promotionSubmit, { dealId }), body)
export const withdrawDeal = (dealId: string) => post<HotelDealDetail>(fill(c.promotionWithdraw, { dealId }))
export const pauseDeal = (dealId: string, body: HotelDealTransitionInput) => post<HotelDealDetail>(fill(c.promotionPause, { dealId }), body)
export const resumeDeal = (dealId: string, body: HotelDealTransitionInput = { expectedVersion: 0 }) => post<HotelDealDetail>(fill(c.promotionResume, { dealId }), body.expectedVersion ? body : {})
export const suspendDeal = (dealId: string, body: HotelDealTransitionInput) => post<HotelDealDetail>(fill(c.promotionSuspend, { dealId }), body)
export const returnDealToDraft = (dealId: string, body: HotelDealTransitionInput) => post<HotelDealDetail>(fill(c.promotionReturnToDraft, { dealId }), body)
export const archiveDeal = (dealId: string, body: HotelDealTransitionInput) => post<HotelDealDetail>(fill(c.promotionArchive, { dealId }), body)
export const decideDealApproval = (approvalId: string, decision: 'approve' | 'reject', body: HotelDealDecisionInput) => post<HotelDealDetail>(fill(decision === 'approve' ? c.promotionApprovalApprove : c.promotionApprovalReject, { approvalId }), body)
export const executeDealApproval = (approvalId: string) => post<HotelDealDetail>(fill(c.promotionApprovalExecute, { approvalId }))
export const reconcileDeals = () => post<HotelDealReconcileResult>(c.promotionReconcile)
export const getDealAuditLog = (dealId: string) => apiRequest<HotelDealAuditTrail>(fill(c.promotionAudit, { dealId }))
export const getDealPerformance = (dealId: string) => apiRequest<HotelDealPerformance>(fill(c.promotionPerformance, { dealId }))
