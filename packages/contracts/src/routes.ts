export const routes = {
  auth: { login: '/auth/login', logout: '/auth/logout', me: '/auth/me' },
  agent: {
    context: '/agent/context', destinations: '/agent/destinations', searchFacets: '/agent/search-facets', hotelImage: '/agent/hotels/:hotelId/images/:imageId/content', searchStatus: '/agent/search/status', search: '/agent/search', recheck: '/agent/rates/recheck', holdOffer: '/agent/offers/:offerId/hold', releaseHold: '/agent/holds/:holdId', prebook: '/agent/prebook',
    bookings: '/agent/bookings', booking: '/agent/bookings/:id', reconcileStaleBookings: '/agent/bookings/reconcile-stale', cancelBooking: '/agent/bookings/:id', cancellationQuote: '/agent/bookings/:id/cancellation-quote', bookingDocument: '/agent/bookings/:id/documents/:type', bookingDocumentHtml: '/agent/bookings/:id/documents/:type/html', financeSummary: '/agent/finance/summary', fundingReceipts: '/agent/funding/receipts', audit: '/agent/audit',
  },
  admin: { dashboard: '/admin/dashboard', settings: '/admin/settings' },
  // Hotel Setup (ADR 0021): descriptive and operational hotel content, saved with optimistic concurrency.
  adminHotelImages: {
    images: '/admin/hotels/:hotelId/images', imagesOrder: '/admin/hotels/:hotelId/images/order', image: '/admin/hotels/:hotelId/images/:imageId', imageContent: '/admin/hotels/:hotelId/images/:imageId/content',
  },
  adminHotelSetup: {
    locationOptions: '/admin/hotels/location-options',
    setup: '/admin/hotels/:hotelId/setup', status: '/admin/hotels/:hotelId/setup/status', ownerCandidates: '/admin/hotels/:hotelId/setup/owner-candidates',
    publicationRequest: '/admin/hotels/:hotelId/setup/publication/request',
    publicationApprove: '/admin/hotels/:hotelId/setup/publication/:approvalId/approve', publicationReject: '/admin/hotels/:hotelId/setup/publication/:approvalId/reject',
    publicationCancel: '/admin/hotels/:hotelId/setup/publication/:approvalId/cancel', publicationExecute: '/admin/hotels/:hotelId/setup/publication/:approvalId/execute',
    rooms: '/admin/hotels/:hotelId/rooms', room: '/admin/hotels/:hotelId/rooms/:roomId',
    roomArchive: '/admin/hotels/:hotelId/rooms/:roomId/archive', roomRestore: '/admin/hotels/:hotelId/rooms/:roomId/restore',
    amenities: '/admin/hotels/:hotelId/amenities',
    quickUpdatePreview: '/admin/hotels/:hotelId/quick-update/preview', quickUpdateApply: '/admin/hotels/:hotelId/quick-update/apply',
  },
  // Inventory & Allotment (ADR 0030): shared pools, release rule and the inventory summary. Calendar and stock edits reuse the commercial calendar and Quick Update.
  adminHotelInventory: {
    summary: '/admin/hotels/:hotelId/inventory/summary', pools: '/admin/hotels/:hotelId/inventory/pools', pool: '/admin/hotels/:hotelId/inventory/pools/:poolId',
    poolMembersAdd: '/admin/hotels/:hotelId/inventory/pools/:poolId/members/add', poolMembersRemove: '/admin/hotels/:hotelId/inventory/pools/:poolId/members/remove',
    planRelease: '/admin/hotels/:hotelId/inventory/rate-plans/:ratePlanId/release',
    poolConsumption: '/admin/hotels/:hotelId/inventory/pools/:poolId/consumption',
    poolCapacityPreview: '/admin/hotels/:hotelId/inventory/pools/:poolId/capacity/preview', poolCapacityApply: '/admin/hotels/:hotelId/inventory/pools/:poolId/capacity/apply',
    poolNightRequests: '/admin/hotels/:hotelId/inventory/pools/:poolId/night-requests', poolNightRequestApprove: '/admin/hotels/:hotelId/inventory/pools/:poolId/night-requests/:approvalId/approve',
    poolNightRequestReject: '/admin/hotels/:hotelId/inventory/pools/:poolId/night-requests/:approvalId/reject', poolNightRequestCancel: '/admin/hotels/:hotelId/inventory/pools/:poolId/night-requests/:approvalId/cancel',
  },
  // Clients, Service and Distribution (ADR 0019): record-keeping and exposure control, no money.
  adminClients: {
    summary: '/admin/clients/summary', agencies: '/admin/clients/agencies', agency: '/admin/clients/agencies/:agencyId',
    agencyMembers: '/admin/clients/agencies/:agencyId/members', agencyMember: '/admin/clients/agencies/:agencyId/members/:userId', memberCandidates: '/admin/clients/member-candidates',
    agencyCreditRequest: '/admin/clients/agencies/:agencyId/request-credit-limit',
    agencyCreditApprove: '/admin/clients/agencies/credit-approvals/:approvalId/approve', agencyCreditReject: '/admin/clients/agencies/credit-approvals/:approvalId/reject',
    agencyCreditCancel: '/admin/clients/agencies/credit-approvals/:approvalId/cancel', agencyCreditExecute: '/admin/clients/agencies/credit-approvals/:approvalId/execute',
    agencySuspensionRequest: '/admin/clients/agencies/:agencyId/request-suspension-change',
    agencySuspensionApprove: '/admin/clients/agencies/suspension-approvals/:approvalId/approve', agencySuspensionReject: '/admin/clients/agencies/suspension-approvals/:approvalId/reject',
    agencySuspensionCancel: '/admin/clients/agencies/suspension-approvals/:approvalId/cancel', agencySuspensionExecute: '/admin/clients/agencies/suspension-approvals/:approvalId/execute',
  },
  adminService: {
    summary: '/admin/service/summary', cases: '/admin/service/cases', case: '/admin/service/cases/:caseId', caseNotes: '/admin/service/cases/:caseId/notes',
    caseTransition: '/admin/service/cases/:caseId/transition', caseAssign: '/admin/service/cases/:caseId/assign', assignees: '/admin/service/assignees',
  },
  adminDistribution: {
    summary: '/admin/distribution/summary', restrictions: '/admin/distribution/restrictions', restrictionRetire: '/admin/distribution/restrictions/:restrictionId/retire',
  },
  // Commercial markup rules for NET rates (ADR 0018). Rules are immutable; activation needs a second person's approval.
  adminCommercial: {
    markups: '/admin/commercial/markups', markupRetire: '/admin/commercial/markups/:ruleId/retire', markupRequestActivation: '/admin/commercial/markups/:ruleId/request-activation',
    markupApprovalApprove: '/admin/commercial/markups/approvals/:approvalId/approve', markupApprovalReject: '/admin/commercial/markups/approvals/:approvalId/reject',
    markupApprovalCancel: '/admin/commercial/markups/approvals/:approvalId/cancel', markupApprovalExecute: '/admin/commercial/markups/approvals/:approvalId/execute',
  },
  // Read-only operational views over the authoritative transaction chain, plus one confirmed reconciliation action.
  adminFunding: {
    receipts: '/admin/funding/receipts', receipt: '/admin/funding/receipts/:receiptId',
    verify: '/admin/funding/receipts/:receiptId/verify', clearCompliance: '/admin/funding/receipts/:receiptId/clear-compliance',
    post: '/admin/funding/receipts/:receiptId/post', reject: '/admin/funding/receipts/:receiptId/reject',
  },
  // Rate plan audit and distribution certification (ADR 0033). Read-only: nothing here repairs, merges or publishes data.
  adminRateCertification: {
    summary: '/admin/rate-certification/summary', plans: '/admin/rate-certification/plans', plan: '/admin/rate-certification/plans/:ratePlanId',
    hotels: '/admin/rate-certification/hotels', markupRules: '/admin/rate-certification/markup-rules', remediation: '/admin/rate-certification/remediation',
    simulate: '/admin/rate-certification/simulate', report: '/admin/rate-certification/report',
  },
  adminOperations: {
    capabilities: '/admin/operations/capabilities', readiness: '/admin/operations/readiness',
    hotels: '/admin/operations/hotels', suppliers: '/admin/operations/suppliers',
    hotelsSummary: '/admin/operations/hotels/summary', hotel: '/admin/operations/hotels/:hotelId',
    hotelContracts: '/admin/operations/hotels/:hotelId/contracts', hotelMappings: '/admin/operations/hotels/:hotelId/mappings',
    hotelCalendar: '/admin/operations/hotels/:hotelId/calendar', hotelSellability: '/admin/operations/hotels/:hotelId/sellability',
    hotelAudit: '/admin/operations/hotels/:hotelId/audit', hotelDistribution: '/admin/operations/hotels/:hotelId/distribution', hotelReadiness: '/admin/operations/hotels/:hotelId/readiness', exceptions: '/admin/operations/exceptions',
    holds: '/admin/operations/holds', hold: '/admin/operations/holds/:holdId',
    bookings: '/admin/operations/bookings', booking: '/admin/operations/bookings/:bookingId',
    /** Phase 2 writes (ADR 0039): `POST bookings` enters a manual booking; the rest act on one booking. All need an Idempotency-Key header. */
    bookingActions: '/admin/operations/bookings/:bookingId/actions', bookingReferences: '/admin/operations/bookings/:bookingId/references', bookingSupplier: '/admin/operations/bookings/:bookingId/supplier',
    /** Operations queue (Phase 4). `bookingOps` is the list; counts, assignees and the per-booking actions hang off it. */
    bookingFinance: '/admin/operations/booking-finance/:bookingId', bookingFinancePenalty: '/admin/operations/booking-finance/:bookingId/penalty', bookingFinanceDocument: '/admin/operations/booking-finance/:bookingId/documents/:type', bookingFinanceDocumentHtml: '/admin/operations/booking-finance/:bookingId/documents/:type/html',
    bookingBulkActions: '/admin/operations/bookings/bulk-actions', bookingBulkAction: '/admin/operations/booking-bulk-actions/:operationId',
    bookingViews: '/admin/operations/booking-views', bookingViewDefaultClear: '/admin/operations/booking-views/default/clear', bookingView: '/admin/operations/booking-views/:viewId', bookingViewDefault: '/admin/operations/booking-views/:viewId/default',
    bookingOps: '/admin/operations/booking-queue', bookingOpsItem: '/admin/operations/booking-queue/:bookingId', bookingOpsAssignees: '/admin/operations/booking-queue/assignees', bookingOpsAssign: '/admin/operations/booking-queue/:bookingId/assign', bookingOpsAcknowledge: '/admin/operations/booking-queue/:bookingId/acknowledge', bookingOpsEscalate: '/admin/operations/booking-queue/:bookingId/escalate', bookingOpsNote: '/admin/operations/booking-queue/:bookingId/note', bookingOpsClear: '/admin/operations/booking-queue/:bookingId/clear', bookingOpsAnswer: '/admin/operations/booking-queue/:bookingId/supplier-answer',
    bookingDocument: '/admin/operations/bookings/:bookingId/documents/:type/html',
    reconciliation: '/admin/operations/reconciliation', reconcile: '/admin/operations/reconciliation/run',
    cancellations: '/admin/operations/cancellations',
    wallets: '/admin/operations/wallets', ledger: '/admin/operations/ledger', agencyAccount: '/admin/operations/agencies/:agencyId/account', receivables: '/admin/operations/receivables', reconciliationApprovals: '/admin/operations/reconciliation/approvals', reconciliationApprovalApprove: '/admin/operations/reconciliation/approvals/:approvalId/approve', reconciliationApprovalReject: '/admin/operations/reconciliation/approvals/:approvalId/reject',
    reconciliationApprovalCancel: '/admin/operations/reconciliation/approvals/:approvalId/cancel', reconciliationApprovalExecute: '/admin/operations/reconciliation/approvals/:approvalId/execute',
    commercialImpact: '/admin/operations/commercial/impact', marketsSummary: '/admin/operations/markets/summary', reliabilitySummary: '/admin/operations/reliability/summary', accessReviewSummary: '/admin/operations/access-review/summary', accessReviewUsers: '/admin/operations/access-review/users',
    financeSummary: '/admin/operations/finance/summary', auditSummary: '/admin/operations/audit/summary',
    audit: '/admin/operations/audit', connectors: '/admin/operations/connectors',
  },
  platform: {
    tenants: '/platform/tenants', tenantSummary: '/platform/tenants/:tenantId/summary',
    permissions: '/platform/access/permissions', roles: '/platform/access/roles', assignments: '/platform/access/assignments', revokeAssignment: '/platform/access/assignments/:userId/:roleId',
  },
  supplier: {
    memberships: '/supplier/extranet/memberships',
    context: '/supplier/extranet/context',
    hotels: '/supplier/extranet/hotels',
    hotel: '/supplier/extranet/hotels/:hotelId',
    rooms: '/supplier/extranet/hotels/:hotelId/rooms',
    roomDraft: '/supplier/extranet/hotels/:hotelId/rooms/:roomId/draft',
  },
  platformAccess: {
    permissions: '/platform/access/permissions', roles: '/platform/access/roles', role: '/platform/access/roles/:roleId', rolePermissions: '/platform/access/roles/:roleId/permissions', assignments: '/platform/access/assignments', assignment: '/platform/access/assignments/:userId/:roleId',
  },
  supply: {
    ratePlanPortfolio: '/supply/rate-plan-portfolio', calendarPreview: '/supply/calendar/preview', calendarApply: '/supply/calendar/apply',
    hotelMappings: '/supply/mappings/hotels', hotelMapping: '/supply/mappings/hotels/:mappingId', roomMappings: '/supply/mappings/hotels/:mappingId/rooms', roomMapping: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId',
    mappingOptions: '/supply/mappings/options', mappingRoomOptions: '/supply/mappings/options/rooms/:mappingId',
    hotelMappingApprove: '/supply/mappings/hotels/:mappingId/approve', hotelMappingReject: '/supply/mappings/hotels/:mappingId/reject', hotelMappingReopen: '/supply/mappings/hotels/:mappingId/reopen',
    roomMappingApprove: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/approve', roomMappingReject: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/reject', roomMappingReopen: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/reopen',
    suppliers: '/supply/suppliers', supplier: '/supply/suppliers/:supplierId',
    hotels: '/supply/hotels', hotel: '/supply/hotels/:hotelId', hotelRooms: '/supply/hotels/:hotelId/rooms', hotelRoom: '/supply/hotels/:hotelId/rooms/:roomId', roomTypes: '/supply/room-types', boardBases: '/supply/board-bases', boardBasesAdmin: '/supply/board-bases/admin', boardBasis: '/supply/board-bases/:boardBasisId',
    contracts: '/supply/contracts', contract: '/supply/contracts/:contractId', contractPolicies: '/supply/contracts/:contractId/policies', cancellationPolicies: '/supply/contracts/:contractId/policies/cancellation', childPolicies: '/supply/contracts/:contractId/policies/child', leadTimeRules: '/supply/contracts/:contractId/policies/lead-time', ratePlans: '/supply/rate-plans', ratePlan: '/supply/rate-plans/:ratePlanId', dailyRates: '/supply/daily-rates', dailyRatesBulk: '/supply/daily-rates/bulk',
    availability: '/supply/availability', availabilityBulk: '/supply/availability/bulk', sellability: '/supply/sellability', capabilities: '/supply/capabilities',
  },
  partner: {},
  health: { status: '/health', ready: '/health/ready' },
} as const;

export type RoutePath = (typeof routes.auth)[keyof typeof routes.auth] | (typeof routes.agent)[keyof typeof routes.agent] | (typeof routes.admin)[keyof typeof routes.admin] | (typeof routes.platform)[keyof typeof routes.platform] | (typeof routes.platformAccess)[keyof typeof routes.platformAccess] | (typeof routes.supplier)[keyof typeof routes.supplier] | (typeof routes.supply)[keyof typeof routes.supply] | (typeof routes.health)[keyof typeof routes.health];
