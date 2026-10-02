/**
 * Contracts for the commercial markup rules API (`/admin/commercial/markups`, ADR 0018).
 * A rule is a percent markup, in integer basis points, on NET daily rates. Rules are immutable: only the status moves.
 */
import type { ApprovalStatusName } from './operations'

export const MARKUP_MAX_BASIS_POINTS = 10_000
export type MarkupScopeName = 'TENANT_DEFAULT' | 'SUPPLIER' | 'HOTEL'
export type MarkupRuleStatusName = 'DRAFT' | 'ACTIVE' | 'RETIRED'
export const MARKUP_SCOPES: readonly MarkupScopeName[] = ['TENANT_DEFAULT', 'SUPPLIER', 'HOTEL']
export const MARKUP_STATUSES: readonly MarkupRuleStatusName[] = ['DRAFT', 'ACTIVE', 'RETIRED']

export interface MarkupApprovalView {
  id: string
  status: ApprovalStatusName
  requestedById: string
  decidedById: string | null
  decisionReason: string | null
  /** True when the caller is not the requester and the request is pending. The server enforces this regardless. */
  canDecide: boolean
  canCancel: boolean
  /** Approved and not yet used: anyone holding supply.rates.manage may activate it, once. */
  canExecute: boolean
}

export interface MarkupRuleView {
  id: string
  scope: MarkupScopeName
  supplierId: string | null
  supplierName: string | null
  hotelId: string | null
  hotelName: string | null
  basisPoints: number
  /** First and last night the rule applies to, inclusive. validTo null is open-ended. */
  validFrom: string
  validTo: string | null
  status: MarkupRuleStatusName
  reason: string
  createdById: string
  createdAt: string
  activatedAt: string | null
  retiredAt: string | null
  /** The most recent activation request for this rule, if any. */
  approval: MarkupApprovalView | null
  /** True when the caller may request activation (a DRAFT with no open request). */
  canRequestActivation: boolean
  canRetire: boolean
}

export interface MarkupRuleCreate {
  scope: MarkupScopeName
  supplierId?: string
  hotelId?: string
  basisPoints: number
  validFrom: string
  validTo?: string
  reason: string
}
export interface MarkupActivationRequest { requestId: string; reason: string }
export interface MarkupDecision { reason: string }
export interface MarkupRulePage { items: MarkupRuleView[]; page: number; pageSize: number; total: number }
export interface MarkupActivationResult { approval: MarkupApprovalView; rule: MarkupRuleView; replacedRuleId: string | null }
