export type SupplyId = string
export type SupplyDate = string

export interface HotelRead { id: string; tenantId: string; name: string; propertyType: string; starRating: number | null; address: string | null; city: string; countryCode: string; timeZone: string; contentStatus: string; externalRef: string | null; createdAt?: string; updatedAt?: string }
export interface HotelWrite { name: string; propertyType: string; starRating?: number | null; address?: string | null; city: string; countryCode: string; timeZone?: string; externalRef?: string | null }
export interface HotelUpdate extends Partial<HotelWrite> {}
export interface RoomTypeRead { id: string; hotelId: string; name: string; code: string; maxAdults: number; maxChildren: number; maxOccupancy: number; beddingMetadata?: Record<string, unknown>; isActive: boolean; createdAt?: string; updatedAt?: string }
export interface RoomTypeWrite { name: string; code: string; maxAdults: number; maxChildren?: number; maxOccupancy: number; beddingMetadata?: Record<string, unknown>; isActive?: boolean }
export interface RoomTypeUpdate extends Partial<RoomTypeWrite> {}
export type MappingStatus = 'PENDING' | 'MAPPED' | 'REJECTED'
export interface HotelMappingRead { id: string; tenantId: string; supplierId: string; hotelId: string; supplierHotelId: string; status: MappingStatus; confidence: number | null; sourceMetadata: Record<string, unknown> }
export interface RoomMappingRead { id: string; tenantId: string; supplierHotelMappingId: string; hotelId: string; supplierRoomId: string; roomTypeId: string; status: MappingStatus; confidence: number | null; sourceMetadata: Record<string, unknown> }
export interface HotelMappingWrite { supplierId: string; hotelId: string; supplierHotelId: string; confidence?: number | null; sourceMetadata?: Record<string, unknown> }
export interface RoomMappingWrite { supplierRoomId: string; roomTypeId: string; confidence?: number | null; sourceMetadata?: Record<string, unknown> }
export type MappingMetadataUpdate = Pick<HotelMappingWrite, 'confidence' | 'sourceMetadata'>
export type SupplierType = 'HOTEL_DIRECT' | 'DMC' | 'CHANNEL_MANAGER' | 'BEDBANK' | 'GDS'
export type SupplierStatus = 'DRAFT' | 'PENDING_REVIEW' | 'ACTIVE' | 'SUSPENDED' | 'INACTIVE'
export interface SupplierRead { id: string; tenantId: string; type: SupplierType; status: SupplierStatus; legalName: string; displayName: string; countryCode: string; defaultCurrency: string; contactMetadata: Record<string, unknown>; createdAt?: string; updatedAt?: string }
export interface SupplierWrite { type: SupplierType; status?: SupplierStatus; legalName: string; displayName: string; countryCode: string; defaultCurrency: string; contactMetadata?: Record<string, unknown> }
export interface SupplierUpdate extends Partial<SupplierWrite> {}
export interface BoardBasisWrite { code: string; name: string; description?: string | null; isActive?: boolean }
export interface BoardBasisUpdate { name?: string; description?: string | null; isActive?: boolean }
export interface BoardBasisRead { id: string; tenantId: string; code: string; name: string; description: string | null; isActive: boolean }
export type ContractStatus = 'DRAFT' | 'REVIEW' | 'ACTIVE' | 'EXPIRED' | 'SUSPENDED'
export interface ContractWrite { supplierId: string; supplierHotelMappingId?: string | null; code: string; status?: ContractStatus; validFrom: SupplyDate; validTo: SupplyDate; settlementCurrency: string; salesMarkets?: string[]; nationalities?: string[]; paymentPolicyRef?: string | null }
export interface ContractUpdate extends Partial<ContractWrite> {}
export interface CancellationPolicyWrite { daysBeforeCheckin: number; penaltyPercent?: number; penaltyMinor?: string; currency?: string }
export interface CancellationPolicyRead { id: string; contractId: string; daysBeforeCheckin: number; penaltyPercent: number | null; penaltyMinor: string | null; currency: string | null; createdAt?: string }
export interface ChildPolicyWrite { minAge: number; maxAge: number; extraBedAllowed?: boolean; supplementMinor?: string; currency?: string }
export interface ChildPolicyRead { id: string; contractId: string; minAge: number; maxAge: number; extraBedAllowed: boolean; supplementMinor: string | null; currency: string | null; createdAt?: string }
export interface LeadTimeRuleWrite { minLeadHours: number; maxLeadDays?: number | null }
export interface LeadTimeRuleRead { id: string; contractId: string; minLeadHours: number; maxLeadDays: number | null; createdAt?: string }
export interface ContractPoliciesRead { id: string; cancellationPolicies: CancellationPolicyRead[]; childPolicies: ChildPolicyRead[]; leadTimeRules: LeadTimeRuleRead[] }
export type CancellationPolicyType = 'REFUNDABLE' | 'NON_REFUNDABLE' | 'CONDITIONAL'
export type CancellationPolicyResolution = 'RESOLVED' | 'UNRESOLVED' | 'CONFLICTED'
export type CancellationPenaltyType = 'ZERO' | 'PERCENTAGE' | 'NIGHTS' | 'FIXED' | 'FULL_AMOUNT'
export type CancellationDeadlineSemantics = 'CALENDAR_DAYS_AT_LOCAL_TIME' | 'ELAPSED_HOURS'
export interface CancellationSimulationRuleInput {
  daysBeforeCheckin?: number
  elapsedHoursBeforeCheckin?: number
  penaltyType?: CancellationPenaltyType
  penaltyPercent?: number | null
  penaltyMinor?: string | null
  penaltyNights?: number | null
  currency?: string | null
}
export interface CancellationPolicySimulationRequest {
  checkIn: SupplyDate
  requestedAt: string
  currency: string
  cancellableAmountMinor: string
  nightlyAmountsMinor?: string[]
  policyType?: CancellationPolicyType
  deadlineSemantics?: CancellationDeadlineSemantics
  propertyTimeZone?: string
  checkInLocalTime?: string
  customerAmountPaidMinor?: string
  retainedFeesMinor?: string
  priorRefundsMinor?: string
  supplierCancellableAmountMinor?: string
  supplierPenaltyOverrideMinor?: string
  rules?: CancellationSimulationRuleInput[]
}
export interface CancellationPolicySimulationResult {
  status: 'quotable' | 'manual_review_required' | 'policy_unavailable'
  policyType: CancellationPolicyType
  policyResolution: CancellationPolicyResolution
  reason?: string
  evaluatedAt: string
  propertyTimeZone: string
  checkInLocalTime: string
  deadlineSemantics: CancellationDeadlineSemantics
  freeCancellationDeadlineUtc: string | null
  selectedWindowDeadlineUtc: string | null
  selectedPenaltyType: CancellationPenaltyType | null
  currency: string
  cancellableAmountMinor: string
  penaltyMinor: string
  refundMinor: string
  customerCancellationLiabilityMinor: string
  customerRefundEntitlementMinor: string
  customerRefundPayableMinor: string
  settlementBalanceMinor: string
  supplierPenaltyMinor: string
  supplierExpectedCreditMinor: string
  discrepancyReviewRequired: boolean
}
export interface ContractRead { id: string; tenantId: string; supplierId: string; supplierHotelMappingId: string | null; code: string; status: string; validFrom: SupplyDate; validTo: SupplyDate; settlementCurrency: string }
export type RatePlanStatus = 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'EXPIRED'
export interface RatePlanWrite { contractId: string; roomTypeId: string; boardBasisId: string; code: string; status?: RatePlanStatus; occupancy: number; currency: string; refundable?: boolean; taxesIncluded?: boolean; feesIncluded?: boolean; minStay?: number; maxStay?: number | null; releaseDays?: number }
export interface RatePlanUpdate extends Partial<RatePlanWrite> {}
export interface RatePlanRead { id: string; tenantId: string; contractId: string; roomTypeId: string; boardBasisId: string; code: string; status: string; occupancy: number; currency: string }
export type RateAmountBasis = 'NET' | 'SELL'
export interface DailyRateRead { id: string; tenantId: string; ratePlanId: string; stayDate: SupplyDate; occupancy: number; amountMinor: string; amountBasis: RateAmountBasis | null; currency: string }
export interface DailyRateWrite { ratePlanId: string; stayDate: SupplyDate; occupancy: number; amountMinor: string; amountBasis: RateAmountBasis; currency: string }
export interface DailyAvailabilityRead { id: string; tenantId: string; ratePlanId: string; stayDate: SupplyDate; allotment: number; sold: number; stopSell: boolean; minStay: number }
export interface SellabilityResult { eligible: boolean; status: 'ELIGIBLE_FOR_FUTURE_SEARCH' | 'NOT_ELIGIBLE'; reasons: string[] }

export type ConnectorFormatType = 'API_JSON' | 'XML_IN' | 'XML_OUT' | 'CHANNEL_MANAGER' | 'MANUAL_EXTRANET'
export type ConnectorLifecycleStatus = 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED'
export interface ConnectorDefinitionRead {
  id: string
  tenantId: string
  supplierId: string
  type: ConnectorFormatType
  status: ConnectorLifecycleStatus
  name: string
  capabilities: string[]
  version: string
  healthState: string
  createdAt?: string
  updatedAt?: string
}
export interface ConnectorDefinitionWrite {
  supplierId: string
  type: ConnectorFormatType
  status?: ConnectorLifecycleStatus
  name: string
  capabilities?: string[]
  version?: string
  secretRef?: string
}
export interface ConnectorInventoryIngestRequest {
  idempotencyKey: string
  format: ConnectorFormatType
  payload: unknown
}
export interface ConnectorInventoryIngestResult {
  eventId: string
  outcome: 'SUCCEEDED' | 'FAILED'
  ingestedRows: number
  validationErrors: string[]
}

export type SupplierCancellationOutcomeStatus = 'CONFIRMED' | 'REJECTED' | 'UNKNOWN' | 'MANUAL_REVIEW'
export interface ExecuteSupplierCancellationRequest {
  bookingId: string
  connectorId?: string
  walletId?: string
  reason: string
  idempotencyKey: string
  requestedAt: string
  expectedCustomerLiabilityMinor: string
  refundMinor: string
  currency: string
  simulatedSupplierOutcome?: 'confirmed' | 'rejected' | 'timeout'
  simulatedSupplierPenaltyMinor?: string
}
export interface ExecuteSupplierCancellationResult {
  bookingId: string
  cancellationId: string | null
  executionStatus: SupplierCancellationOutcomeStatus
  refundStatus: 'NOT_DUE' | 'READY' | 'SUCCEEDED' | 'PENDING_RECONCILIATION'
  supplierCancellationRef: string | null
  supplierPenaltyMinor: string | null
  customerLiabilityMinor: string
  refundMinor: string
  currency: string
  discrepancyReviewRequired: boolean
  ledgerEntryId: string | null
  voucherNotificationIds: string[]
}

export interface WalletLedgerSummaryRead {
  walletId: string
  tenantId: string
  currency: string
  creditLimitMinor: string
  durableBalanceMinor: string
  availableCreditMinor: string
  entries: Array<{
    id: string
    type: 'CREDIT' | 'DEBIT' | 'HOLD' | 'RELEASE' | 'REFUND'
    amountMinor: string
    currency: string
    reference: string | null
    idempotencyKey: string
    immutableAt: string
  }>
}
export interface PostLedgerAdjustmentRequest {
  walletId?: string
  bookingId?: string
  currency: string
  type: 'REFUND' | 'CREDIT' | 'DEBIT' | 'RELEASE'
  amountMinor: string
  authorizedRefundableMinor?: string
  reference: string
  idempotencyKey: string
}
export interface PostLedgerAdjustmentResult {
  entryId: string
  walletId: string
  type: 'REFUND' | 'CREDIT' | 'DEBIT' | 'RELEASE'
  amountMinor: string
  currency: string
  reference: string | null
  availableCreditMinor: string
  durableBalanceMinor: string
  creditLimitMinor: string
}

export type CancellationVoucherChannel = 'CLIENT_EMAIL' | 'SUPPLIER_WEBHOOK'
export interface DispatchCancellationVoucherRequest {
  bookingId: string
  bookingReference: string
  supplierCancellationRef?: string | null
  channels: CancellationVoucherChannel[]
  currency: string
  penaltyMinor: string
  refundMinor: string
  idempotencyKey: string
}
export interface CancellationVoucherDeliveryRead {
  id: string
  bookingId: string
  bookingReference: string
  channel: CancellationVoucherChannel
  status: 'DISPATCHED' | 'QUEUED_FOR_RETRY'
  supplierCancellationRef: string | null
  currency: string
  penaltyMinor: string
  refundMinor: string
  idempotencyKey: string
  dispatchedAt: string
}

export const supplyRoutes = {
  hotelMappings: '/supply/mappings/hotels', hotelMapping: '/supply/mappings/hotels/:mappingId', roomMappings: '/supply/mappings/hotels/:mappingId/rooms', roomMapping: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId',
  mappingOptions: '/supply/mappings/options', mappingRoomOptions: '/supply/mappings/options/rooms/:mappingId',
  hotelMappingApprove: '/supply/mappings/hotels/:mappingId/approve', hotelMappingReject: '/supply/mappings/hotels/:mappingId/reject', hotelMappingReopen: '/supply/mappings/hotels/:mappingId/reopen',
  roomMappingApprove: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/approve', roomMappingReject: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/reject', roomMappingReopen: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/reopen',
  suppliers: '/supply/suppliers', supplier: '/supply/suppliers/:supplierId',
  hotels: '/supply/hotels', hotelRooms: '/supply/hotels/:hotelId/rooms', hotelRoom: '/supply/hotels/:hotelId/rooms/:roomId', roomTypes: '/supply/room-types', boardBases: '/supply/board-bases', boardBasesAdmin: '/supply/board-bases/admin', boardBasis: '/supply/board-bases/:boardBasisId', contracts: '/supply/contracts', contract: '/supply/contracts/:contractId', contractPolicies: '/supply/contracts/:contractId/policies', cancellationPolicies: '/supply/contracts/:contractId/policies/cancellation', simulateCancellationPolicy: '/supply/contracts/:contractId/policies/cancellation/simulate', childPolicies: '/supply/contracts/:contractId/policies/child', leadTimeRules: '/supply/contracts/:contractId/policies/lead-time', ratePlans: '/supply/rate-plans', ratePlan: '/supply/rate-plans/:ratePlanId', dailyRates: '/supply/daily-rates', dailyRatesBulk: '/supply/daily-rates/bulk', availability: '/supply/availability', availabilityBulk: '/supply/availability/bulk', sellability: '/supply/sellability',
  connectors: '/supply/connectors', connectorIngestInventory: '/supply/connectors/:connectorId/ingest-inventory',
  cancellationsExecute: '/supply/cancellations/execute',
  ledgerAdjustments: '/supply/finance/ledger-adjustments',
  cancellationVouchers: '/supply/notifications/cancellation-vouchers',
} as const

export const supplyPermissions = {
  mappingsRead: 'supply.mappings.read', mappingsManage: 'supply.mappings.manage',
  suppliersRead: 'supply.suppliers.read', suppliersManage: 'supply.suppliers.manage',
  hotelsRead: 'supply.hotels.read', hotelsManage: 'supply.hotels.manage', roomsRead: 'supply.rooms.read', roomsManage: 'supply.rooms.manage', contractsRead: 'supply.contracts.read', contractsManage: 'supply.contracts.manage', ratesRead: 'supply.rates.read', ratesManage: 'supply.rates.manage', availabilityRead: 'supply.availability.read', availabilityManage: 'supply.availability.manage',
} as const
export type SupplyPermission = (typeof supplyPermissions)[keyof typeof supplyPermissions]

export function serializeSupply<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item)) as T
}
