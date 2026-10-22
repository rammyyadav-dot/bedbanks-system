import { agentRoutes, authRoutes } from './agent-routes';

export const routes = {
  auth: authRoutes,
  agent: agentRoutes,
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
    // Controlled FX (ADR 0067 F-12): same maker-checker lifecycle as markups.
    fxRates: '/admin/commercial/fx-rates', fxRateRetire: '/admin/commercial/fx-rates/:rateId/retire', fxRateRequestActivation: '/admin/commercial/fx-rates/:rateId/request-activation',
    fxApprovalApprove: '/admin/commercial/fx-rates/approvals/:approvalId/approve', fxApprovalReject: '/admin/commercial/fx-rates/approvals/:approvalId/reject',
    fxApprovalCancel: '/admin/commercial/fx-rates/approvals/:approvalId/cancel', fxApprovalExecute: '/admin/commercial/fx-rates/approvals/:approvalId/execute',
  },
  // Read-only operational views over the authoritative transaction chain, plus one confirmed reconciliation action.
  adminFunding: {
    receipts: '/admin/funding/receipts', receipt: '/admin/funding/receipts/:receiptId',
    verify: '/admin/funding/receipts/:receiptId/verify', clearCompliance: '/admin/funding/receipts/:receiptId/clear-compliance',
    post: '/admin/funding/receipts/:receiptId/post', reject: '/admin/funding/receipts/:receiptId/reject',
  },
  // Supplier statement reconciliation and the dispute queue (ADR 0070). Writes need an `Idempotency-Key`-style `requestId` in the body.
  adminFinanceReconciliation: {
    statements: '/admin/finance/reconciliation/statements', statementsStream: '/admin/finance/reconciliation/statements/stream', statement: '/admin/finance/reconciliation/statements/:statementId',
    run: '/admin/finance/reconciliation/statements/:statementId/runs',
    exceptions: '/admin/finance/reconciliation/exceptions', exceptionSummary: '/admin/finance/reconciliation/exceptions/summary', exception: '/admin/finance/reconciliation/exceptions/:exceptionId',
    propose: '/admin/finance/reconciliation/exceptions/:exceptionId/propose', approve: '/admin/finance/reconciliation/exceptions/:exceptionId/approve', reject: '/admin/finance/reconciliation/exceptions/:exceptionId/reject',
  },
  // Backlog of the booking Finance consumer (ADR 0076). Read-only.
  adminBookingFinancePostings: { backlog: '/admin/finance/booking-postings', revenue: '/admin/finance/booking-postings/revenue', payables: '/admin/finance/booking-postings/payables', payablesAging: '/admin/finance/booking-postings/payables/aging' },
  // Rate plan audit and distribution certification (ADR 0033). Read-only: nothing here repairs, merges or publishes data.
  adminRateCertification: {
    summary: '/admin/rate-certification/summary', plans: '/admin/rate-certification/plans', plan: '/admin/rate-certification/plans/:ratePlanId',
    hotels: '/admin/rate-certification/hotels', markupRules: '/admin/rate-certification/markup-rules', remediation: '/admin/rate-certification/remediation',
    simulate: '/admin/rate-certification/simulate', report: '/admin/rate-certification/report',
  },
  adminOperations: {
    capabilities: '/admin/operations/capabilities', readiness: '/admin/operations/readiness',
    hotels: '/admin/operations/hotels', suppliers: '/admin/operations/suppliers',
    hotelsSummary: '/admin/operations/hotels/summary', hotelsExport: '/admin/operations/hotels/export', searchMonitor: '/admin/operations/search-monitor', hotel: '/admin/operations/hotels/:hotelId',
    hotelReports: '/admin/operations/hotels/:hotelId/reports',
    hotelReportsExport: '/admin/operations/hotels/:hotelId/reports/export',
    hotelContracts: '/admin/operations/hotels/:hotelId/contracts', hotelMappings: '/admin/operations/hotels/:hotelId/mappings',
    hotelCalendar: '/admin/operations/hotels/:hotelId/calendar', hotelSellability: '/admin/operations/hotels/:hotelId/sellability',
    hotelAudit: '/admin/operations/hotels/:hotelId/audit', hotelDistribution: '/admin/operations/hotels/:hotelId/distribution', hotelReadiness: '/admin/operations/hotels/:hotelId/readiness', exceptions: '/admin/operations/exceptions',
    holds: '/admin/operations/holds', hold: '/admin/operations/holds/:holdId',
    bookings: '/admin/operations/bookings', booking: '/admin/operations/bookings/:bookingId',
    /** Phase 2 writes (ADR 0039): `POST bookings` enters a manual booking; the rest act on one booking. All need an Idempotency-Key header. */
    bookingActions: '/admin/operations/bookings/:bookingId/actions', bookingReferences: '/admin/operations/bookings/:bookingId/references', bookingSupplier: '/admin/operations/bookings/:bookingId/supplier',
    /** Operations queue (Phase 4). `bookingOps` is the list; counts, assignees and the per-booking actions hang off it. */
    bookingFinance: '/admin/operations/booking-finance/:bookingId', bookingFinancePenalty: '/admin/operations/booking-finance/:bookingId/penalty', bookingFinanceDocument: '/admin/operations/booking-finance/:bookingId/documents/:type', bookingFinanceDocumentHtml: '/admin/operations/booking-finance/:bookingId/documents/:type/html',
    bookingExport: '/admin/operations/bookings/export', bookingBulkActions: '/admin/operations/bookings/bulk-actions', bookingBulkAction: '/admin/operations/booking-bulk-actions/:operationId',
    bookingViews: '/admin/operations/booking-views', bookingViewDefaultClear: '/admin/operations/booking-views/default/clear', bookingView: '/admin/operations/booking-views/:viewId', bookingViewDefault: '/admin/operations/booking-views/:viewId/default',
    bookingOps: '/admin/operations/booking-queue', bookingOpsItem: '/admin/operations/booking-queue/:bookingId', bookingOpsAssignees: '/admin/operations/booking-queue/assignees', bookingOpsAssign: '/admin/operations/booking-queue/:bookingId/assign', bookingOpsAcknowledge: '/admin/operations/booking-queue/:bookingId/acknowledge', bookingOpsEscalate: '/admin/operations/booking-queue/:bookingId/escalate', bookingOpsNote: '/admin/operations/booking-queue/:bookingId/note', bookingOpsClear: '/admin/operations/booking-queue/:bookingId/clear', bookingOpsAnswer: '/admin/operations/booking-queue/:bookingId/supplier-answer',
    bookingDocument: '/admin/operations/bookings/:bookingId/documents/:type/html',
    reconciliation: '/admin/operations/reconciliation', reconcile: '/admin/operations/reconciliation/run',
    cancellations: '/admin/operations/cancellations',
    wallets: '/admin/operations/wallets', ledger: '/admin/operations/ledger', agencyAccount: '/admin/operations/agencies/:agencyId/account', receivables: '/admin/operations/receivables', supplierPayables: '/admin/operations/supplier-payables', creditNotes: '/admin/operations/credit-notes', reconciliationApprovals: '/admin/operations/reconciliation/approvals', reconciliationApprovalApprove: '/admin/operations/reconciliation/approvals/:approvalId/approve', reconciliationApprovalReject: '/admin/operations/reconciliation/approvals/:approvalId/reject',
    reconciliationApprovalCancel: '/admin/operations/reconciliation/approvals/:approvalId/cancel', reconciliationApprovalExecute: '/admin/operations/reconciliation/approvals/:approvalId/execute',
    commercialImpact: '/admin/operations/commercial/impact', marketsSummary: '/admin/operations/markets/summary', reliabilitySummary: '/admin/operations/reliability/summary', accessReviewSummary: '/admin/operations/access-review/summary', accessReviewUsers: '/admin/operations/access-review/users',
    complianceSummary: '/admin/operations/compliance/summary', complianceRecords: '/admin/operations/compliance/records', complianceReport: '/admin/operations/compliance/report',
    financeSummary: '/admin/operations/finance/summary', ledgerIntegrity: '/admin/operations/finance/ledger-integrity', cancellationSettlements: '/admin/operations/finance/cancellation-settlements', auditSummary: '/admin/operations/audit/summary',
    audit: '/admin/operations/audit', connectors: '/admin/operations/connectors',
  },
  platform: {
    tenantCreate: '/platform/tenants', tenantProfile: '/platform/tenants/:tenantId/profile', tenantMemberships: '/platform/tenants/:tenantId/memberships', tenantLifecycle: '/platform/tenants/:tenantId/lifecycle', tenantCompliance: '/platform/tenants/:tenantId/compliance', tenantAudit: '/platform/tenants/:tenantId/audit', tenantApproval: '/platform/tenants/:tenantId/approvals/:approvalId', tenants: '/platform/tenants', tenantSummary: '/platform/tenants/:tenantId/summary',
    permissions: '/platform/access/permissions', roles: '/platform/access/roles', assignments: '/platform/access/assignments', revokeAssignment: '/platform/access/assignments/:userId/:roleId',
  },
  supplier: {
    memberships: '/supplier/extranet/memberships',
    context: '/supplier/extranet/context',
    hotels: '/supplier/extranet/hotels',
    hotel: '/supplier/extranet/hotels/:hotelId',
    rooms: '/supplier/extranet/hotels/:hotelId/rooms',
    roomDraft: '/supplier/extranet/hotels/:hotelId/rooms/:roomId/draft',
    contracts: '/supplier/extranet/contracts',
    bookings: '/supplier/extranet/bookings',
    booking: '/supplier/extranet/bookings/:bookingId',
    bookingAnswer: '/supplier/extranet/bookings/:bookingId/answer',
    changeSets: '/supplier/extranet/change-sets',
    changeSetPreview: '/supplier/extranet/change-sets/preview',
    changeSet: '/supplier/extranet/change-sets/:changeSetId',
    changeSetSubmit: '/supplier/extranet/change-sets/:changeSetId/submit',
    changeSetWithdraw: '/supplier/extranet/change-sets/:changeSetId/withdraw',
  },
  platformAccess: {
    permissions: '/platform/access/permissions', roles: '/platform/access/roles', role: '/platform/access/roles/:roleId', rolePermissions: '/platform/access/roles/:roleId/permissions', assignments: '/platform/access/assignments', assignment: '/platform/access/assignments/:userId/:roleId',
  },
  supply: {
    ratePlanPortfolio: '/supply/rate-plan-portfolio', calendarPreview: '/supply/calendar/preview', calendarImportPreview: '/supply/calendar/import/preview', calendarApply: '/supply/calendar/apply',
    hotelMappings: '/supply/mappings/hotels', hotelMapping: '/supply/mappings/hotels/:mappingId', roomMappings: '/supply/mappings/hotels/:mappingId/rooms', roomMapping: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId',
    mappingOptions: '/supply/mappings/options', mappingRoomOptions: '/supply/mappings/options/rooms/:mappingId', hotelMappingSuggestions: '/supply/mappings/hotels/suggestions',
    hotelMappingApprove: '/supply/mappings/hotels/:mappingId/approve', hotelMappingReject: '/supply/mappings/hotels/:mappingId/reject', hotelMappingReopen: '/supply/mappings/hotels/:mappingId/reopen',
    roomMappingApprove: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/approve', roomMappingReject: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/reject', roomMappingReopen: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/reopen',
    ratePlanMappings: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/rate-plans', ratePlanMappingOptions: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/rate-plan-options',
    ratePlanMappingApprove: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/rate-plans/:ratePlanMappingId/approve', ratePlanMappingReject: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/rate-plans/:ratePlanMappingId/reject', ratePlanMappingReopen: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/rate-plans/:ratePlanMappingId/reopen',
    suppliers: '/supply/suppliers', supplier: '/supply/suppliers/:supplierId',
    hotels: '/supply/hotels', hotel: '/supply/hotels/:hotelId', hotelRooms: '/supply/hotels/:hotelId/rooms', hotelRoom: '/supply/hotels/:hotelId/rooms/:roomId', roomTypes: '/supply/room-types', boardBases: '/supply/board-bases', boardBasesAdmin: '/supply/board-bases/admin', boardBasis: '/supply/board-bases/:boardBasisId',
    contracts: '/supply/contracts', contract: '/supply/contracts/:contractId', contractPolicies: '/supply/contracts/:contractId/policies', cancellationPolicies: '/supply/contracts/:contractId/policies/cancellation', childPolicies: '/supply/contracts/:contractId/policies/child', leadTimeRules: '/supply/contracts/:contractId/policies/lead-time', ratePlans: '/supply/rate-plans', ratePlanCapabilities: '/supply/rate-plans/capabilities', ratePlan: '/supply/rate-plans/:ratePlanId', ratePlanReadiness: '/supply/rate-plans/:ratePlanId/readiness', ratePlanActivate: '/supply/rate-plans/:ratePlanId/activate', ratePlanSuspend: '/supply/rate-plans/:ratePlanId/suspend', ratePlanClone: '/supply/rate-plans/:ratePlanId/clone', ratePlanGuestPrices: '/supply/rate-plans/:ratePlanId/guest-prices', ratePlanPromotions: '/supply/rate-plans/:ratePlanId/promotions', hotelPromotionsBulkApply: '/supply/hotels/:hotelId/promotions/bulk-apply', ratePlanDerivation: '/supply/rate-plans/:ratePlanId/derivation', ratePlanActivationRequest: '/supply/rate-plans/:ratePlanId/activation-request', ratePlanActivationApproval: '/supply/rate-plans/:ratePlanId/activation-approval', ratePlanApprovalApprove: '/supply/rate-plan-approvals/:approvalId/approve', ratePlanApprovalReject: '/supply/rate-plan-approvals/:approvalId/reject', ratePlanApprovalCancel: '/supply/rate-plan-approvals/:approvalId/cancel', ratePlanApprovalExecute: '/supply/rate-plan-approvals/:approvalId/execute', dailyRates: '/supply/daily-rates', dailyRatesBulk: '/supply/daily-rates/bulk',
    contractLifecycle: '/supply/contracts/:contractId/lifecycle', contractSubmit: '/supply/contracts/:contractId/submit', contractReturnToDraft: '/supply/contracts/:contractId/return-to-draft', contractSuspend: '/supply/contracts/:contractId/suspend', contractActivationRequest: '/supply/contracts/:contractId/activation-request', contractAmendmentRequest: '/supply/contracts/:contractId/amendment-request',
    contractApprovalApprove: '/supply/contract-approvals/:approvalId/approve', contractApprovalReject: '/supply/contract-approvals/:approvalId/reject', contractApprovalCancel: '/supply/contract-approvals/:approvalId/cancel', contractApprovalExecute: '/supply/contract-approvals/:approvalId/execute',
    contractCancellationPolicy: '/supply/contracts/:contractId/policies/cancellation/:policyId', contractChildPolicy: '/supply/contracts/:contractId/policies/child/:policyId', contractSupplements: '/supply/contracts/:contractId/supplements', contractSupplement: '/supply/contracts/:contractId/supplements/:supplementId',
    availability: '/supply/availability', availabilityBulk: '/supply/availability/bulk', sellability: '/supply/sellability', capabilities: '/supply/capabilities',
  },
  partner: {},
  /** B2B Distribution API for machine partners (ADR 0075). Authenticated by API key or OAuth2 bearer token, never by a session. */
  distribution: { oauthToken: '/distribution/v1/oauth/token', me: '/distribution/v1/me' },
  health: { status: '/health', ready: '/health/ready' },
} as const;

export type RoutePath = (typeof routes.auth)[keyof typeof routes.auth] | (typeof routes.agent)[keyof typeof routes.agent] | (typeof routes.admin)[keyof typeof routes.admin] | (typeof routes.platform)[keyof typeof routes.platform] | (typeof routes.platformAccess)[keyof typeof routes.platformAccess] | (typeof routes.supplier)[keyof typeof routes.supplier] | (typeof routes.supply)[keyof typeof routes.supply] | (typeof routes.distribution)[keyof typeof routes.distribution] | (typeof routes.health)[keyof typeof routes.health];
