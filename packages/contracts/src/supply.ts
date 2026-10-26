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
export interface ContractWrite { supplierId: string; supplierHotelMappingId?: string | null; code: string; status?: ContractStatus; validFrom: SupplyDate; validTo: SupplyDate; settlementCurrency: string; salesMarkets?: string[]; nationalities?: string[]; paymentPolicyRef?: string | null
  /** ADR 0067 F-20/F-15. Editable while DRAFT, REVIEW or SUSPENDED; amended on an ACTIVE contract. */
  rateType?: 'NET' | 'COMMISSIONABLE' | null; commissionBp?: number | null; paymentTermsDays?: number | null; signedAt?: SupplyDate | null; signedDocumentRef?: string | null
  allotmentType?: 'GUARANTEED' | 'NON_GUARANTEED' | 'FREE_SALE' | null; minStayMode?: 'STAY_THROUGH' | 'ARRIVAL'; clientBufferDays?: number
  /** Governance (not reviewed terms): editable unless EXPIRED. The owner must be a member of the tenant. */
  ownerUserId?: string | null; renewalReminderDays?: number }
export interface ContractUpdate extends Partial<ContractWrite> {}
export interface CancellationPolicyWrite { daysBeforeCheckin: number; penaltyPercent?: number; penaltyMinor?: string; currency?: string }
export interface ChildPolicyWrite { minAge: number; maxAge: number; extraBedAllowed?: boolean; supplementMinor?: string; currency?: string }
export interface LeadTimeRuleWrite { minLeadHours: number; maxLeadDays?: number | null }
export interface ContractRead { id: string; tenantId: string; supplierId: string; supplierHotelMappingId: string | null; code: string; status: string; validFrom: SupplyDate; validTo: SupplyDate; settlementCurrency: string }
export type RatePlanStatus = 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'EXPIRED'
export interface RatePlanWrite { contractId: string; roomTypeId: string; boardBasisId: string; code: string; status?: RatePlanStatus; occupancy: number; currency: string; refundable?: boolean; taxesIncluded?: boolean; feesIncluded?: boolean; minStay?: number; maxStay?: number | null; releaseDays?: number }
export interface RatePlanUpdate extends Partial<RatePlanWrite> {}
export interface RatePlanRead { id: string; tenantId: string; contractId: string; roomTypeId: string; boardBasisId: string; code: string; status: string; occupancy: number; currency: string }
export type RateAmountBasis = 'NET' | 'SELL'
export interface DailyRateRead { id: string; tenantId: string; ratePlanId: string; stayDate: SupplyDate; occupancy: number; amountMinor: string; amountBasis: RateAmountBasis | null; currency: string }
export interface DailyRateWrite { ratePlanId: string; stayDate: SupplyDate; occupancy: number; amountMinor: string; amountBasis: RateAmountBasis; currency: string }
export interface DailyAvailabilityRead { id: string; tenantId: string; ratePlanId: string; stayDate: SupplyDate; allotment: number; sold: number; stopSell: boolean; minStay: number }
export interface SellabilityRequest { ratePlanId: string; stayDate: SupplyDate; occupancy: number; checkInDate?: SupplyDate; nights?: number }
export interface SupplyCapabilities { permissions: SupplyPermission[] }
export interface SellabilityResult { eligible: boolean; status: 'ELIGIBLE_FOR_FUTURE_SEARCH' | 'NOT_ELIGIBLE'; reasons: string[]; /** Non-blocking notes, e.g. HOTEL_CONTENT_NOT_COMPLETE (sellable but not visible to agent search). */ warnings?: string[] }

/** Query for ranked canonical-hotel suggestions. Advisory only: a suggestion never creates or approves a mapping (maker-checker, ADR 0004). */
export interface HotelMappingSuggestionQuery { name: string; address?: string; city?: string; /** ISO 3166-1 alpha-2. */ countryCode?: string }
export interface HotelMappingSuggestion { hotelId: string; name: string; city: string; countryCode: string; /** Integer 0..100. */ confidence: number; tier: 'EXACT' | 'HIGH_CONFIDENCE' | 'REVIEW_REQUIRED'; reasons: string[] }
/** `indexReady: false` means the tenant's HotelSearchIndex has no rows yet (run the reindex job); it is never answered with an empty "no match". */
export interface HotelMappingSuggestions { indexReady: boolean; suggestions: HotelMappingSuggestion[] }

export const supplyRoutes = {
  ratePlanPortfolio: '/supply/rate-plan-portfolio', ratePlanCapabilities: '/supply/rate-plans/capabilities', ratePlanReadiness: '/supply/rate-plans/:ratePlanId/readiness', ratePlanActivate: '/supply/rate-plans/:ratePlanId/activate', ratePlanSuspend: '/supply/rate-plans/:ratePlanId/suspend', ratePlanClone: '/supply/rate-plans/:ratePlanId/clone', ratePlanGuestPrices: '/supply/rate-plans/:ratePlanId/guest-prices', ratePlanPromotions: '/supply/rate-plans/:ratePlanId/promotions', hotelPromotionsBulkApply: '/supply/hotels/:hotelId/promotions/bulk-apply', ratePlanDerivation: '/supply/rate-plans/:ratePlanId/derivation', ratePlanActivationRequest: '/supply/rate-plans/:ratePlanId/activation-request', ratePlanActivationApproval: '/supply/rate-plans/:ratePlanId/activation-approval', ratePlanApprovalApprove: '/supply/rate-plan-approvals/:approvalId/approve', ratePlanApprovalReject: '/supply/rate-plan-approvals/:approvalId/reject', ratePlanApprovalCancel: '/supply/rate-plan-approvals/:approvalId/cancel', ratePlanApprovalExecute: '/supply/rate-plan-approvals/:approvalId/execute', calendarPreview: '/supply/calendar/preview', calendarImportPreview: '/supply/calendar/import/preview', calendarApply: '/supply/calendar/apply',
  hotelMappings: '/supply/mappings/hotels', hotelMapping: '/supply/mappings/hotels/:mappingId', roomMappings: '/supply/mappings/hotels/:mappingId/rooms', roomMapping: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId',
  mappingOptions: '/supply/mappings/options', mappingRoomOptions: '/supply/mappings/options/rooms/:mappingId', hotelMappingSuggestions: '/supply/mappings/hotels/suggestions',
  hotelMappingApprove: '/supply/mappings/hotels/:mappingId/approve', hotelMappingReject: '/supply/mappings/hotels/:mappingId/reject', hotelMappingReopen: '/supply/mappings/hotels/:mappingId/reopen',
  roomMappingApprove: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/approve', roomMappingReject: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/reject', roomMappingReopen: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/reopen',
  suppliers: '/supply/suppliers', supplier: '/supply/suppliers/:supplierId',
  hotels: '/supply/hotels', hotelRooms: '/supply/hotels/:hotelId/rooms', hotelRoom: '/supply/hotels/:hotelId/rooms/:roomId', roomTypes: '/supply/room-types', roomTypePortfolio: '/supply/room-type-portfolio', boardBases: '/supply/board-bases', boardBasesAdmin: '/supply/board-bases/admin', boardBasis: '/supply/board-bases/:boardBasisId', contracts: '/supply/contracts', contractPortfolio: '/supply/contract-portfolio', contract: '/supply/contracts/:contractId', contractPolicies: '/supply/contracts/:contractId/policies', cancellationPolicies: '/supply/contracts/:contractId/policies/cancellation', childPolicies: '/supply/contracts/:contractId/policies/child', leadTimeRules: '/supply/contracts/:contractId/policies/lead-time', ratePlans: '/supply/rate-plans', ratePlan: '/supply/rate-plans/:ratePlanId', dailyRates: '/supply/daily-rates', dailyRatesBulk: '/supply/daily-rates/bulk', availability: '/supply/availability', availabilityBulk: '/supply/availability/bulk', sellability: '/supply/sellability', capabilities: '/supply/capabilities',
  // ADR 0089: Room Event Master and event/exhibition supplements.
  roomEvents: '/admin/room-events', roomEvent: '/admin/room-events/:roomEventId', roomEventSubmit: '/admin/room-events/:roomEventId/submit', roomEventCancel: '/admin/room-events/:roomEventId/cancel', roomEventArchive: '/admin/room-events/:roomEventId/archive',
  roomEventApprovalApprove: '/admin/room-event-approvals/:approvalId/approve', roomEventApprovalReject: '/admin/room-event-approvals/:approvalId/reject', roomEventApprovalCancel: '/admin/room-event-approvals/:approvalId/cancel',
  eventSupplements: '/admin/event-supplements', eventSupplement: '/admin/event-supplements/:eventSupplementId', eventSupplementSubmit: '/admin/event-supplements/:eventSupplementId/submit', eventSupplementActivate: '/admin/event-supplements/:eventSupplementId/activate', eventSupplementSuspend: '/admin/event-supplements/:eventSupplementId/suspend', eventSupplementPreview: '/admin/event-supplements/preview',
  eventSupplementAmendmentRequest: '/admin/event-supplements/:eventSupplementId/amendment-request',
  eventSupplementApprovalApprove: '/admin/event-supplement-approvals/:approvalId/approve', eventSupplementApprovalReject: '/admin/event-supplement-approvals/:approvalId/reject', eventSupplementApprovalCancel: '/admin/event-supplement-approvals/:approvalId/cancel', eventSupplementApprovalExecute: '/admin/event-supplement-approvals/:approvalId/execute',
} as const

export const supplyPermissions = {
  mappingsRead: 'supply.mappings.read', mappingsManage: 'supply.mappings.manage',
  suppliersRead: 'supply.suppliers.read', suppliersManage: 'supply.suppliers.manage',
  hotelsRead: 'supply.hotels.read', hotelsManage: 'supply.hotels.manage', /** Download the filtered hotel directory as CSV (ADR 0051). Granted to no role by default. */ hotelsExport: 'supply.hotels.export', roomsRead: 'supply.rooms.read', roomsManage: 'supply.rooms.manage', contractsRead: 'supply.contracts.read', contractsManage: 'supply.contracts.manage', ratesRead: 'supply.rates.read', ratesManage: 'supply.rates.manage', availabilityRead: 'supply.availability.read', availabilityManage: 'supply.availability.manage',
  /** Pool capacity editor (ADR 0036): previewing an edit and applying it are separate grants. Viewing pools and consumption stays supply.availability.read. */
  poolCapacityPreview: 'supply.pool_capacity.preview', poolCapacityApply: 'supply.pool_capacity.apply',
  /** Request (maker) and decide (checker) opening new pool nights (ADR 0036 Amendment 3). A request cannot be decided by its maker. */
  poolNightsRequest: 'supply.pool_nights.request', poolNightsDecide: 'supply.pool_nights.decide',
  /** Room Event Master and event/exhibition supplements (ADR 0089). The approval-only `room_event.approve` and `event_supplement.approve`
   * keys (admin-departments.ts) refine these and gate the maker-checker lifecycle; a request cannot be decided by its maker. */
  roomEventsRead: 'supply.room_events.read', roomEventsManage: 'supply.room_events.manage',
  eventSupplementsRead: 'supply.event_supplements.read', eventSupplementsManage: 'supply.event_supplements.manage',
} as const
export type SupplyPermission = (typeof supplyPermissions)[keyof typeof supplyPermissions]

// ADR 0089: Room Event Master and event/exhibition supplements.
export const ROOM_EVENT_TYPES = ['EXHIBITION', 'TRADE_FAIR', 'CONFERENCE', 'FESTIVAL', 'PEAK_SEASON', 'OTHER'] as const
export type RoomEventType = (typeof ROOM_EVENT_TYPES)[number]
export const ROOM_EVENT_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'CANCELLED', 'ARCHIVED'] as const
export type RoomEventStatus = (typeof ROOM_EVENT_STATUSES)[number]
export interface RoomEventWrite { name: string; eventType: RoomEventType; destinationCity: string; destinationCountry: string; eventStartDate: SupplyDate; eventEndDate: SupplyDate; referenceRef?: string | null; internalNotes?: string | null }
export interface RoomEventUpdate extends Partial<RoomEventWrite> {}
export interface RoomEventRead { id: string; tenantId: string; name: string; eventType: RoomEventType; destinationCity: string; destinationCountry: string; eventStartDate: SupplyDate; eventEndDate: SupplyDate; status: RoomEventStatus; referenceRef: string | null; internalNotes: string | null; createdById: string; approvedById: string | null; approvedAt: string | null; createdAt: string; updatedAt: string }
export interface RoomEventTransitionInput { reason: string }
export interface RoomEventApprovalDecisionInput { reason: string }

export const EVENT_SUPPLEMENT_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'SUSPENDED', 'EXPIRED'] as const
export type EventSupplementStatus = (typeof EVENT_SUPPLEMENT_STATUSES)[number]
export type EventSupplementAmountKind = 'FIXED' | 'PERCENTAGE'
export type EventSupplementTaxTreatment = 'INCLUSIVE' | 'EXCLUSIVE'
/** FIXED carries basis/frequency/amountMinor (reuses ContractSupplement's shape) and no percentBp; PERCENTAGE carries percentBp of the
 * eligible contracted base and none of the fixed fields. Exactly one shape, enforced by the API and a database check constraint. */
export type EventSupplementAmount =
  | { amountKind: 'FIXED'; basis: 'PER_ADULT' | 'PER_CHILD' | 'PER_PERSON' | 'PER_ROOM'; frequency: 'PER_NIGHT' | 'PER_STAY'; amountMinor: string }
  | { amountKind: 'PERCENTAGE'; percentBp: number }
export type EventSupplementWrite = EventSupplementAmount & {
  roomEventId: string; contractId: string; ratePlanId?: string | null; currency: string; taxTreatment?: EventSupplementTaxTreatment
  validFrom: SupplyDate; validTo: SupplyDate; stackable?: boolean; priority?: number; evidenceRef: string
}
export interface EventSupplementRead { id: string; tenantId: string; roomEventId: string; contractId: string; ratePlanId: string | null; amountKind: EventSupplementAmountKind; basis: string | null; frequency: string | null; amountMinor: string | null; percentBp: number | null; currency: string; taxTreatment: EventSupplementTaxTreatment; validFrom: SupplyDate; validTo: SupplyDate; stackable: boolean; priority: number; evidenceRef: string; status: EventSupplementStatus; version: number; createdById: string; approvedById: string | null; activatedAt: string | null; suspendedAt: string | null; createdAt: string; updatedAt: string }
export interface EventSupplementActivationRequestInput { reason: string; requestId?: string }
export interface EventSupplementApprovalDecisionInput { reason: string }
export interface EventSupplementSuspendInput { reason: string }
/** Commercial terms only: never the event, contract or rate plan binding (those are fixed at creation, like a contract's supplier/hotel
 * binding is never amendable, ADR 0067 F-01). */
export type EventSupplementAmendment = Partial<EventSupplementAmount & Pick<EventSupplementWrite, 'currency' | 'taxTreatment' | 'validFrom' | 'validTo' | 'stackable' | 'priority' | 'evidenceRef'>>
export interface EventSupplementAmendmentRequestInput { changes: EventSupplementAmendment; reason: string; requestId?: string }
/** Executes an approved amendment or activation request, named by its approvalId (mirrors contractApprovalExecute). */
export interface EventSupplementApprovalExecuteInput { reason: string }
/** Price impact preview (spec section 7, "Rate Impact Preview"): never a mutation. */
export interface EventSupplementPreviewRequest { ratePlanId: string; stayDates: SupplyDate[]; rooms: number; adults: number; children: number }
export interface EventSupplementPreviewNight { date: SupplyDate; contractedBaseMinor: string; eventSupplementMinor: string; adjustedNetMinor: string }
export interface EventSupplementPreviewResult { currency: string; nights: EventSupplementPreviewNight[]; eventSupplements: Array<{ roomEventId: string; roomEventName: string; amountMinor: string }> }

export function serializeSupply<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item)) as T
}
