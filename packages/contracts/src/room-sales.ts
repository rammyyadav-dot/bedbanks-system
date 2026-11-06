/**
 * Room Availability and Allocation Management (ADR 0113).
 *
 * Inventory, sales controls and commercial eligibility stay separate. A Free Sale rule never creates unlimited stock
 * unless the supplier contract's allotment type is FREE_SALE. Configured mode and effective outcome are both returned
 * by the API; the browser does not calculate stock.
 */

export const ROOM_SALES_MODES = ['FREE_SALE', 'STOP_SALE', 'ON_REQUEST', 'LIMITED'] as const
export type RoomSalesMode = (typeof ROOM_SALES_MODES)[number]

export const ROOM_SALES_OUTCOMES = ['INSTANT', 'ON_REQUEST', 'STOPPED', 'UNAVAILABLE', 'NOT_CONFIGURED'] as const
export type RoomSalesOutcome = (typeof ROOM_SALES_OUTCOMES)[number]

export const POST_RELEASE_POLICIES = ['CLOSED', 'ON_REQUEST', 'AUTHORIZED_FREE_SALE'] as const
export type PostReleasePolicy = (typeof POST_RELEASE_POLICIES)[number]

export const SALES_DISTRIBUTION_STATES = ['PENDING', 'ACKNOWLEDGED', 'FAILED'] as const
export type SalesDistributionState = (typeof SALES_DISTRIBUTION_STATES)[number]

export const SUPPLIER_REQUEST_STATES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] as const
export type SupplierRequestState = (typeof SUPPLIER_REQUEST_STATES)[number]

export const ROOM_SALES_LIMITS = {
  reasonMin: 3,
  reasonMax: 500,
  rangeDays: 62,
  cells: 2000,
  capMax: 9999,
  deadlineHoursMax: 168,
  ownerMax: 80,
  escalationMax: 200,
} as const

/** A saved sales-control rule as the evaluator reads it. Empty scope keys mean "all". */
export interface RoomSalesRuleView {
  roomTypeId: string
  stayDate: string
  poolKey: string
  planKey: string
  channelKey: string
  marketKey: string
  contractKey: string
  mode: RoomSalesMode
  salesCap: number | null
  consumesInventory: boolean
  overrideExpiresAt: string | null
}

export interface RoomSalesScope {
  poolId: string | null
  ratePlanId: string | null
  channel: string | null
  market: string | null
  contractId: string | null
}

export interface RoomSalesSettings {
  mode: RoomSalesMode
  salesCap?: number | null
  responseDeadlineHours?: number | null
  requestOwnerLabel?: string | null
  escalationPolicy?: string | null
}

export interface RoomSalesCellChange {
  roomTypeId: string
  stayDate: string
  /** Version on screen. Null means the operator saw no rule at this exact scope. */
  expectedVersion: number | null
}

export interface RoomSalesPreviewRequest extends RoomSalesScope, RoomSalesSettings {
  roomTypeIds: string[]
  allRoomTypes: boolean
  from: string
  to: string
  weekdays?: string[]
  reason: string
  confirmBroadReopen?: boolean
  /** Painted cells. When present, only these room nights are saved. */
  cells?: RoomSalesCellChange[]
}

export interface RoomSalesCommitRequest extends RoomSalesPreviewRequest {
  expectedFingerprint: string
  idempotencyKey: string
}

export interface RoomSalesProposedChange {
  roomTypeId: string
  roomName: string
  stayDate: string
  fromMode: RoomSalesMode | null
  toMode: RoomSalesMode
  problems: string[]
}

export interface RoomSalesPreview {
  fingerprint: string
  hotelId: string
  timeZone: string
  scopeLabel: string
  from: string
  to: string
  roomTypeIds: string[]
  affected: number
  changes: RoomSalesProposedChange[]
  errors: string[]
  canSave: boolean
  distributionNote: string
}

export interface RoomSalesCommitResult {
  replayed: boolean
  batchId: string
  affected: number
  distribution: { jobId: string; state: SalesDistributionState; simulated: true; label: string }
  auditRequestId: string
}

export interface RoomSalesInventoryView {
  poolId: string | null
  poolName: string
  contracted: number | null
  approvedAdjustment: number | null
  confirmed: number | null
  activeHolds: number | null
  blocked: number | null
  blockedExcludedFromAllocation: boolean
  remaining: number | null
  consistent: boolean | null
  overCommitment: boolean
  releaseCutoff: string | null
  postReleasePolicy: PostReleasePolicy | null
}

export interface RoomSalesCell {
  roomTypeId: string
  stayDate: string
  configuredMode: RoomSalesMode | null
  version: number | null
  effectiveOutcome: RoomSalesOutcome
  effectiveReasons: string[]
  salesCap: number | null
  capRemaining: number | null
  overCap: boolean
  consumesInventory: boolean
  scopeLabel: string
  source: string | null
  actorName: string | null
  updatedAt: string | null
  reason: string | null
  inventory: RoomSalesInventoryView | null
  rateState: 'VERIFIED' | 'MISSING' | 'QUARANTINED'
  distributionState: SalesDistributionState | null
}

export interface RoomSalesCalendar {
  hotelId: string
  hotelName: string
  timeZone: string
  hotelToday: string
  generatedAt: string
  window: { from: string; to: string; days: number }
  scope: RoomSalesScope
  scopeLabel: string
  contracts: Array<{ id: string; code: string; allotmentType: string | null; supplierName: string }>
  pools: Array<{ id: string; name: string; supplierId: string; supplierName: string }>
  ratePlans: Array<{ id: string; code: string; roomTypeId: string; roomName: string; poolId: string | null; contractId: string; contractCode: string; boardCode: string }>
  channels: string[]
  markets: string[]
  rooms: Array<{ id: string; name: string; maxAdults: number; maxChildren: number; maxOccupancy: number }>
  dates: string[]
  cells: RoomSalesCell[]
  jobs: Array<{ id: string; state: SalesDistributionState; attempts: number; lastError: string | null; simulated: true; label: string; createdAt: string }>
  notes: string[]
}

export interface AllocationNightView {
  roomTypeId: string
  roomName: string
  poolId: string | null
  poolName: string
  stayDate: string
  contracted: number | null
  approvedAdjustment: number | null
  confirmed: number | null
  activeHolds: number | null
  blocked: number | null
  blockedExcludedFromAllocation: boolean
  remaining: number | null
  consistent: boolean | null
  overCommitment: boolean
  releaseCutoff: string | null
  postReleasePolicy: PostReleasePolicy | null
  exists: boolean
  version: number | null
}

export interface AllocationBoard {
  hotelId: string
  hotelName: string
  timeZone: string
  hotelToday: string
  generatedAt: string
  window: { from: string; to: string; days: number }
  dates: string[]
  rows: Array<{ roomTypeId: string; roomName: string; poolId: string | null; poolName: string; nights: AllocationNightView[] }>
  /** Null when a night in the loaded window has no stock row, so a save of that window is refused. */
  fingerprints: Array<{ poolId: string; fingerprint: string | null }>
  notes: string[]
}

export interface AllocationEditRequest {
  poolId: string
  from: string
  to: string
  weekdays?: string[]
  contracted: number
  approvedAdjustment: number
  blocked: number
  blockedExcludedFromAllocation: boolean
  postReleasePolicy: PostReleasePolicy
  releaseCutoffDays: number | null
  releaseTimeLocal: string | null
  responseDeadlineHours?: number | null
  requestOwnerLabel?: string | null
  escalationPolicy?: string | null
  reason: string
  expectedFingerprint: string
  idempotencyKey: string
}

export interface AllocationEditResult {
  replayed: boolean
  updated: number
  overCommitmentNights: string[]
  auditRequestId: string
}

export interface SalesHistoryEntry {
  at: string
  actorName: string
  source: string
  reason: string
  beforeMode: RoomSalesMode | null
  afterMode: RoomSalesMode | null
  beforeCap: number | null
  afterCap: number | null
}

export interface SalesEligibilityRequest {
  ratePlanId: string
  checkIn: string
  checkOut: string
  rooms: number
  adults: number
  children: number
  channel?: string | null
  market?: string | null
}

export interface SalesEligibilityResult {
  outcome: 'INSTANT' | 'ON_REQUEST' | 'REJECTED'
  reasons: string[]
  nights: string[]
  note: string
}

export interface SupplierStayRequestBody extends SalesEligibilityRequest {
  idempotencyKey: string
  responseDeadlineHours: number
  requestOwnerLabel: string
  escalationPolicy: string
  reason: string
}

export interface SupplierStayRequestView {
  id: string
  status: SupplierRequestState
  deadlineAt: string
  ownerLabel: string
  escalationPolicy: string
  replayed: boolean
  note: string
}

export interface SupplierStayDecision {
  decision: 'APPROVE' | 'REJECT'
  reason: string
  idempotencyKey: string
}
