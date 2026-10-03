/**
 * Contracts for Clients, Service and Distribution (ADR 0019).
 * Record-keeping and exposure control only: nothing here moves money, sets a credit limit or changes a booking.
 */

export const departmentPermissions = {
  agencyRead: 'agency.read', agencyManage: 'agency.manage',
  caseRead: 'case.read', caseManage: 'case.manage',
  distributionRead: 'distribution.read', distributionManage: 'distribution.manage',
} as const
export type DepartmentPermission = (typeof departmentPermissions)[keyof typeof departmentPermissions]

// ---- Clients ---------------------------------------------------------------------------------------------------------
export const AGENCY_STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED'] as const
export type AgencyStatusName = (typeof AGENCY_STATUSES)[number]
/** Statuses a plain edit may set. SUSPENDED is reached and left only through an approved maker-checker request (ADR 0020). */
export const AGENCY_EDITABLE_STATUSES = ['ACTIVE', 'INACTIVE'] as const
export type AgencyEditableStatusName = (typeof AGENCY_EDITABLE_STATUSES)[number]
export const AGENCY_SUSPENSION_CHANGES = ['SUSPEND', 'REINSTATE'] as const
export type AgencySuspensionChange = (typeof AGENCY_SUSPENSION_CHANGES)[number]
export const AGENCY_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,38}[A-Z0-9]$/

export interface AgencyView {
  id: string; code: string; name: string; countryCode: string | null; status: AgencyStatusName; notes: string | null; memberCount: number; createdAt: string
  /** Latest open (pending or approved) suspension or reinstatement request, if any. Present on the detail view only. */
  suspension?: AgencySuspensionApprovalView | null
}
export interface AgencyCreate { code: string; name: string; countryCode?: string; notes?: string }
/** Fields left out are unchanged; null clears countryCode or notes. The code never changes. */
export interface AgencyUpdate { name?: string; countryCode?: string | null; notes?: string | null; status?: AgencyEditableStatusName }
export interface AgencySuspensionApprovalView {
  id: string
  change: AgencySuspensionChange
  status: string
  requestedById: string
  decidedById: string | null
  decisionReason: string | null
  canDecide: boolean
  canCancel: boolean
  canExecute: boolean
}
export interface AgencySuspensionRequest { requestId: string; change: AgencySuspensionChange; reason: string }
export interface AgencySuspensionDecision { reason: string }
export interface AgencySuspensionResult { approval: AgencySuspensionApprovalView; agency: AgencyView }
export interface AgencyMemberView { userId: string; email: string; name: string | null; userStatus: string; addedAt: string }
export interface AgencyMemberCandidate { userId: string; email: string; name: string | null }
export interface AgencyPage { items: AgencyView[]; page: number; pageSize: number; total: number }
export interface ClientsSummary {
  generatedAt: string
  agencies: { total: number; active: number; inactive: number; suspended: number }
  /** Tenant members, split by whether an agency record includes them. */
  members: { total: number; inAnAgency: number; notInAnyAgency: number }
  definitions: Record<string, string>
}

// ---- Service ---------------------------------------------------------------------------------------------------------
export const CASE_CATEGORIES = ['BOOKING', 'HOTEL', 'SUPPLIER', 'AGENCY', 'OTHER'] as const
export const CASE_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const
export const CASE_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const
export type CaseCategory = (typeof CASE_CATEGORIES)[number]
export type CasePriority = (typeof CASE_PRIORITIES)[number]
export type CaseStatus = (typeof CASE_STATUSES)[number]
/** The only status moves a case can make. CLOSED is final. The API enforces this; the Admin uses it to offer buttons. */
export const CASE_TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  OPEN: ['IN_PROGRESS', 'CLOSED'], IN_PROGRESS: ['RESOLVED', 'OPEN'], RESOLVED: ['CLOSED', 'IN_PROGRESS'], CLOSED: [],
}

export interface CaseNoteView { id: string; authorEmail: string; body: string; createdAt: string }
export interface CaseView {
  id: string; reference: string; subject: string; description: string
  category: CaseCategory; priority: CasePriority; status: CaseStatus
  booking: { id: string; reference: string } | null
  hotel: { id: string; name: string } | null
  supplier: { id: string; name: string } | null
  agency: { id: string; name: string } | null
  openedByEmail: string; assignee: { id: string; email: string } | null
  createdAt: string; updatedAt: string; resolvedAt: string | null; closedAt: string | null
  allowedTransitions: CaseStatus[]
}
export interface CaseDetail extends CaseView { notes: CaseNoteView[] }
export interface CaseCreate {
  subject: string; description: string; category: CaseCategory; priority?: CasePriority
  bookingId?: string; hotelId?: string; supplierId?: string; agencyId?: string; assigneeId?: string
}
export interface CaseTransition { to: CaseStatus; note?: string }
export interface CaseAssign { assigneeId: string | null }
export interface CaseNoteCreate { body: string }
export interface CasePage { items: CaseView[]; page: number; pageSize: number; total: number }
export interface CaseAssignee { id: string; email: string; name: string | null }
export interface ServiceSummary {
  generatedAt: string
  byStatus: { open: number; inProgress: number; resolved: number; closed: number }
  /** Cases not yet resolved or closed with nobody assigned. */
  unassigned: number
  /** Unresolved cases at the highest priority. */
  urgentUnresolved: number
  oldestUnresolvedAt: string | null
  definitions: Record<string, string>
}

// ---- Distribution ----------------------------------------------------------------------------------------------------
export const DISTRIBUTION_SCOPES = ['HOTEL', 'SUPPLIER'] as const
export const DISTRIBUTION_STATUSES = ['ACTIVE', 'RETIRED'] as const
export type DistributionScopeName = (typeof DISTRIBUTION_SCOPES)[number]
export type DistributionStatusName = (typeof DISTRIBUTION_STATUSES)[number]
export interface RestrictionView {
  id: string; agency: { id: string; name: string; code: string }; scope: DistributionScopeName
  hotel: { id: string; name: string } | null; supplier: { id: string; name: string } | null
  status: DistributionStatusName; reason: string; createdAt: string; retiredAt: string | null
}
export interface RestrictionCreate { agencyId: string; scope: DistributionScopeName; hotelId?: string; supplierId?: string; reason: string }
export interface RestrictionPage { items: RestrictionView[]; page: number; pageSize: number; total: number }
export interface DistributionSummary {
  generatedAt: string
  active: number
  agenciesRestricted: number
  byScope: { hotel: number; supplier: number }
  /** Agency members who currently have at least one restriction applied. */
  membersAffected: number
  definitions: Record<string, string>
}
