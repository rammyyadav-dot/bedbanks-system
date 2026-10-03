export const routes = {
  auth: { login: '/auth/login', logout: '/auth/logout', me: '/auth/me' },
  agent: {
    context: '/agent/context', destinations: '/agent/destinations', searchFacets: '/agent/search-facets', searchStatus: '/agent/search/status', search: '/agent/search', recheck: '/agent/rates/recheck', holdOffer: '/agent/offers/:offerId/hold', releaseHold: '/agent/holds/:holdId', prebook: '/agent/prebook',
    bookings: '/agent/bookings', booking: '/agent/bookings/:id', reconcileStaleBookings: '/agent/bookings/reconcile-stale', cancelBooking: '/agent/bookings/:id', cancellationQuote: '/agent/bookings/:id/cancellation-quote', bookingDocument: '/agent/bookings/:id/documents/:type', bookingDocumentHtml: '/agent/bookings/:id/documents/:type/html', financeSummary: '/agent/finance/summary', audit: '/agent/audit',
  },
  admin: { dashboard: '/admin/dashboard', settings: '/admin/settings' },
  // Hotel Setup (ADR 0021): descriptive and operational hotel content, saved with optimistic concurrency.
  adminHotelSetup: {
    setup: '/admin/hotels/:hotelId/setup', status: '/admin/hotels/:hotelId/setup/status',
    rooms: '/admin/hotels/:hotelId/rooms', room: '/admin/hotels/:hotelId/rooms/:roomId',
    roomArchive: '/admin/hotels/:hotelId/rooms/:roomId/archive', roomRestore: '/admin/hotels/:hotelId/rooms/:roomId/restore',
    amenities: '/admin/hotels/:hotelId/amenities',
    quickUpdatePreview: '/admin/hotels/:hotelId/quick-update/preview', quickUpdateApply: '/admin/hotels/:hotelId/quick-update/apply',
  },
  // Clients, Service and Distribution (ADR 0019): record-keeping and exposure control, no money.
  adminClients: {
    summary: '/admin/clients/summary', agencies: '/admin/clients/agencies', agency: '/admin/clients/agencies/:agencyId',
    agencyMembers: '/admin/clients/agencies/:agencyId/members', agencyMember: '/admin/clients/agencies/:agencyId/members/:userId', memberCandidates: '/admin/clients/member-candidates',
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
  adminOperations: {
    capabilities: '/admin/operations/capabilities', readiness: '/admin/operations/readiness',
    hotels: '/admin/operations/hotels', suppliers: '/admin/operations/suppliers',
    hotelsSummary: '/admin/operations/hotels/summary', hotel: '/admin/operations/hotels/:hotelId',
    hotelContracts: '/admin/operations/hotels/:hotelId/contracts', hotelMappings: '/admin/operations/hotels/:hotelId/mappings',
    hotelCalendar: '/admin/operations/hotels/:hotelId/calendar', hotelSellability: '/admin/operations/hotels/:hotelId/sellability',
    hotelAudit: '/admin/operations/hotels/:hotelId/audit', exceptions: '/admin/operations/exceptions',
    holds: '/admin/operations/holds', hold: '/admin/operations/holds/:holdId',
    bookings: '/admin/operations/bookings', booking: '/admin/operations/bookings/:bookingId',
    bookingDocument: '/admin/operations/bookings/:bookingId/documents/:type/html',
    reconciliation: '/admin/operations/reconciliation', reconcile: '/admin/operations/reconciliation/run',
    cancellations: '/admin/operations/cancellations',
    wallets: '/admin/operations/wallets', ledger: '/admin/operations/ledger', reconciliationApprovals: '/admin/operations/reconciliation/approvals', reconciliationApprovalApprove: '/admin/operations/reconciliation/approvals/:approvalId/approve', reconciliationApprovalReject: '/admin/operations/reconciliation/approvals/:approvalId/reject',
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
