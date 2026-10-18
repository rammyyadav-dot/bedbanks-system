/**
 * Contract lifecycle, maker-checker and versioning (ADR 0067, finding F-01).
 *
 * A contract becomes ACTIVE only through an approved, single-use request decided by a second person and bound to the SHA-256 fingerprint of the
 * exact terms reviewed (header and every policy). While ACTIVE or EXPIRED its terms are locked; an ACTIVE contract changes only through an
 * approved amendment, which raises `version` by one and appends an immutable snapshot. DRAFT -> REVIEW, REVIEW -> DRAFT and ACTIVE -> SUSPENDED
 * are single-actor moves.
 */
export type ContractLifecycleStatus = 'DRAFT' | 'REVIEW' | 'ACTIVE' | 'EXPIRED' | 'SUSPENDED'
export type ContractApprovalKind = 'ACTIVATE' | 'AMEND'
export type ContractApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXECUTED'

export interface ContractCancellationTerm { policySet: string | null; daysBeforeCheckin: number; penaltyPercent: number | null; penaltyMinor: string | null; currency: string | null }
export interface ContractChildTerm { minAge: number; maxAge: number; extraBedAllowed: boolean; supplementMinor: string | null; currency: string | null }
export interface ContractLeadTimeTerm { minLeadHours: number; maxLeadDays: number | null }
export interface ContractTermsView {
  code: string; supplierId: string; supplierHotelMappingId: string | null; validFrom: string; validTo: string; settlementCurrency: string
  salesMarkets: string[]; nationalities: string[]; paymentPolicyRef: string | null
  cancellationPolicies: ContractCancellationTerm[]; childPolicies: ContractChildTerm[]; leadTimeRule: ContractLeadTimeTerm | null
}
/** The terms an amendment may change. Supplier and hotel binding are identity and never amendable. Policy lists replace the whole set. */
export type ContractAmendmentChanges = Partial<Pick<ContractTermsView, 'code' | 'validFrom' | 'validTo' | 'settlementCurrency' | 'salesMarkets' | 'nationalities' | 'paymentPolicyRef' | 'cancellationPolicies' | 'childPolicies' | 'leadTimeRule'>>

export interface ContractCheckView { code: string; label: string; ok: boolean; message: string }
export interface ContractApprovalView {
  id: string; contractId: string; kind: ContractApprovalKind; status: ContractApprovalStatus; reason: string
  requestedById: string; decidedById: string | null; decisionReason: string | null; decidedAt: string | null; executedAt: string | null; createdAt: string
  changes: ContractAmendmentChanges | null
  /** True when the terms are no longer the ones the request was bound to: it can no longer be approved or applied. */
  changedSinceRequest: boolean
  isRequester: boolean; canDecide: boolean; canCancel: boolean; canExecute: boolean
}
export interface ContractVersionView { version: number; kind: 'ACTIVATION' | 'AMENDMENT'; fingerprint: string; requestedById: string; approvedById: string; appliedById: string; reason: string; createdAt: string; terms: ContractTermsView }
export interface ContractLifecycleView {
  contractId: string; status: string; version: number; updatedAt: string
  /** Bind requests to this: `expectedFingerprint`. */
  fingerprint: string
  /** False while ACTIVE or EXPIRED: edit through an amendment (ACTIVE) or not at all (EXPIRED). */
  termsEditable: boolean
  readiness: { ready: boolean; checks: ContractCheckView[] }
  openRequest: ContractApprovalView | null
  recentRequests: ContractApprovalView[]
  versions: ContractVersionView[]
}
export interface ContractTransitionInput { expectedUpdatedAt: string; reason?: string }
export interface ContractActivationRequestInput { requestId: string; reason: string; expectedFingerprint: string }
export interface ContractAmendmentRequestInput extends ContractActivationRequestInput { changes: ContractAmendmentChanges }
export interface ContractApprovalDecisionInput { reason: string }
export interface ContractApprovalExecuteResult { approval: ContractApprovalView; contractId: string; status: string; version: number }

export const contractLifecycleRoutes = {
  lifecycle: '/supply/contracts/:contractId/lifecycle',
  submit: '/supply/contracts/:contractId/submit',
  returnToDraft: '/supply/contracts/:contractId/return-to-draft',
  suspend: '/supply/contracts/:contractId/suspend',
  activationRequest: '/supply/contracts/:contractId/activation-request',
  amendmentRequest: '/supply/contracts/:contractId/amendment-request',
  approve: '/supply/contract-approvals/:approvalId/approve',
  reject: '/supply/contract-approvals/:approvalId/reject',
  cancel: '/supply/contract-approvals/:approvalId/cancel',
  execute: '/supply/contract-approvals/:approvalId/execute',
  deleteCancellationPolicy: '/supply/contracts/:contractId/policies/cancellation/:policyId',
  deleteChildPolicy: '/supply/contracts/:contractId/policies/child/:policyId',
  deleteLeadTimeRule: '/supply/contracts/:contractId/policies/lead-time',
} as const
