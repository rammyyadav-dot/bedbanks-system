import { Body, Controller, Get, HttpCode, Logger, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Request, Response } from 'express'
import { departmentPermissions, operationsPermissions, type BookingAccessView, type CancellationSettlementRequest, type DepartmentPermission, type OperationsCapabilities, type OperationsPermission, type ReconcileRequest, type ReconciliationApprovalDecision, type ReconciliationApprovalRequest } from '@bedbanks/contracts'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { AgentRbacGuard, RequirePermission } from '../agent/rbac.guard'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { PrismaService } from '../database/prisma.service'
import { BookingAccess, BookingAccessGuard, RequireBookingAction } from '../booking-ops/booking-access.guard'
import { OperationsHotelsService } from './operations-hotels.service'
import { HotelOnboardingFunnelService } from './hotel-onboarding-funnel.service'
import { OperationsBookingsService } from './operations-bookings.service'
import { OperationsFinanceAuditService } from './operations-finance-audit.service'
import { OperationsLedgerIntegrityService } from './operations-ledger-integrity.service'
import { CancellationSettlementService } from '../agent/cancellation-settlement.service'
import { OperationsReconciliationApprovalsService } from './operations-reconciliation-approvals.service'
import { OperationsGovernanceService } from './operations-governance.service'
import { OperationsComplianceService } from './operations-compliance.service'
import { complianceReportCsv } from './compliance-report'
import { OperationsSupplyService } from './operations-supply.service'
import { RequireSupplyPermission, SupplyPermissionGuard } from './supply-permission.guard'
import { OperationsTransactionsService } from './operations-transactions.service'
import { DualApprovalGuard, RequireDualApproval, RequireStepUp, StepUpGuard } from '../approvals/dual-approval.guard'

type Q = Record<string, unknown>
const requestIdOf = (req: Request) => (req as Request & { requestId?: string }).requestId ?? randomUUID()

/**
 * Read-only Admin operations API, plus one reconcile action that delegates to the existing idempotent service.
 * Tenant identity is derived by TenantContextGuard from the session; every handler declares a permission.
 */
@ApiTags('admin-operations')
@Controller('admin/operations')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class OperationsController {
  private readonly logger = new Logger(OperationsController.name)

  constructor(private readonly prisma: PrismaService, private readonly onboarding: HotelOnboardingFunnelService, private readonly supply: OperationsSupplyService, private readonly tx: OperationsTransactionsService, private readonly hotelOps: OperationsHotelsService, private readonly bookingsRead: OperationsBookingsService, private readonly finAudit: OperationsFinanceAuditService, private readonly reconApprovals: OperationsReconciliationApprovalsService, private readonly governance: OperationsGovernanceService, private readonly integrity: OperationsLedgerIntegrityService, private readonly compliance: OperationsComplianceService, private readonly settlement: CancellationSettlementService) {}

  /** The caller's own operations permissions, used only to hide controls; each endpoint still enforces its own. */
  @Get('capabilities')
  async capabilities(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser): Promise<OperationsCapabilities> {
    const roles = await this.prisma.withTenant(tenantId, t => t.userRole.findMany({ where: { tenantId, userId: identity.user.id, role: { tenantId } }, include: { role: { include: { permissions: { include: { permission: true } } } } } }))
    const keys = new Set(roles.flatMap(r => r.role.permissions.map(p => p.permission.key)))
    const membership = await this.prisma.withTenant(tenantId, t => t.membership.findUnique({ where: { userId_tenantId: { userId: identity.user.id, tenantId } } }))
    const all = Object.values(operationsPermissions) as OperationsPermission[]
    const permissions = all.filter(p => keys.has(p) || membership?.role === 'owner' || (p === 'finance.read' && membership?.role === 'finance'))
    // Department permissions (ADR 0019) come from formal roles only, exactly as the guard checks them.
    const department = (Object.values(departmentPermissions) as DepartmentPermission[]).filter(p => keys.has(p))
    return { permissions: [...permissions, ...department] }
  }

  /** Tenant-wide onboarding funnel. Stages beyond hotel content are evaluated only when the caller also holds that domain's read permission. */
  @Get('onboarding-funnel') @RequireSupplyPermission('supply.hotels.read') @UseGuards(SupplyPermissionGuard)
  onboardingFunnel(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser) { return this.onboarding.report(tenantId, identity.user.id) }

  @Get('readiness') @RequirePermission('booking.read') @UseGuards(AgentRbacGuard)
  readiness(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Query() query: Q) {
    return this.supply.readiness(tenantId, identity.user.id, query, () => this.tx.transactionSummary(tenantId), () => this.tx.connectorSummary(tenantId))
  }

  // ---- hotel commercial operations: existing supply.* permissions, formal roles only (same rule as /supply) ------------------
  @Get('hotels') @RequireSupplyPermission('supply.hotels.read') @UseGuards(SupplyPermissionGuard)
  hotels(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.hotelOps.list(tenantId, query) }

  @Get('search-monitor') @RequirePermission('audit.read') @UseGuards(AgentRbacGuard)
  searchMonitor(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.hotelOps.searchMonitor(tenantId, query) }

  // Declared before `hotels/:hotelId` so "export" is never read as an id. Own permission (ADR 0051); S2 data egress is audited by the service.
  @Get('hotels/export') @RequireSupplyPermission('supply.hotels.export') @UseGuards(SupplyPermissionGuard)
  async hotelsExport(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request, @Query() query: Q, @Res() response: Response) {
    // ADR 0074: streamed. The audit event is written inside openExportStream, before the first byte; the row count and truncation flag are known up front from a count.
    const out = await this.hotelOps.openExportStream(tenantId, identity.user.id, query, requestIdOf(req))
    // Headers are set explicitly because @Res() takes over the response. No Content-Length: the body is chunked and backpressured by the client.
    response.status(200).set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="hotels.csv"', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'X-Export-Rows': String(out.expectedRows), 'X-Export-Truncated': String(out.truncated) })
    // pipeline destroys the generator when the client goes away (stops reading) and aborts the response when a read fails, so a broken export is never a clean file.
    await pipeline(Readable.from(out.chunks), response).catch((error: NodeJS.ErrnoException) => {
      if (error?.code !== 'ERR_STREAM_PREMATURE_CLOSE') this.logger.error(`hotel export stream failed (${error?.code ?? error?.name ?? 'error'})`)
    })
  }

  // Declared before `hotels/:hotelId` so "summary" is never read as an id.
  @Get('hotels/summary') @RequireSupplyPermission('supply.hotels.read') @UseGuards(SupplyPermissionGuard)
  hotelsSummary(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.hotelOps.summary(tenantId, query) }

  @Get('hotels/:hotelId') @RequireSupplyPermission('supply.hotels.read') @UseGuards(SupplyPermissionGuard)
  hotel(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @Query() query: Q) { return this.hotelOps.detail(tenantId, hotelId, query) }

  @Get('hotels/:hotelId/contracts') @RequireSupplyPermission('supply.contracts.read') @UseGuards(SupplyPermissionGuard)
  hotelContracts(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @Query() query: Q) { return this.hotelOps.contracts(tenantId, hotelId, query) }

  @Get('hotels/:hotelId/mappings') @RequireSupplyPermission('supply.mappings.read') @UseGuards(SupplyPermissionGuard)
  hotelMappings(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string) { return this.hotelOps.mappings(tenantId, hotelId) }

  @Get('hotels/:hotelId/calendar') @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  hotelCalendar(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @Query() query: Q) { return this.hotelOps.calendar(tenantId, hotelId, query) }

  @Get('hotels/:hotelId/sellability') @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  hotelSellability(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Query() query: Q) { return this.hotelOps.sellability(tenantId, hotelId, query, identity.user.id) }

  @Get('hotels/:hotelId/distribution') @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  hotelDistribution(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @Query() query: Q) { return this.hotelOps.distribution(tenantId, hotelId, query) }

  @Get('hotels/:hotelId/readiness') @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  hotelReadiness(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Query() query: Q) { return this.hotelOps.readiness(tenantId, hotelId, query, identity.user.id) }

  @Get('hotels/:hotelId/audit') @RequirePermission('audit.read') @UseGuards(AgentRbacGuard)
  hotelAudit(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @Query() query: Q) { return this.hotelOps.audit(tenantId, hotelId, query) }

  @Get('exceptions') @RequireSupplyPermission('supply.hotels.read') @UseGuards(SupplyPermissionGuard)
  exceptions(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.hotelOps.exceptions(tenantId, query) }

  @Get('suppliers') @RequirePermission('booking.read') @UseGuards(AgentRbacGuard)
  suppliers(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Query() query: Q) { return this.supply.suppliers(tenantId, identity.user.id, query) }

  @Get('holds') @RequirePermission('booking.read') @UseGuards(AgentRbacGuard)
  holds(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.tx.holds(tenantId, query) }

  @Get('holds/:holdId') @RequirePermission('booking.read') @UseGuards(AgentRbacGuard)
  hold(@ActiveTenant() tenantId: string, @Param('holdId') holdId: string) { return this.tx.hold(tenantId, holdId) }

  // Booking list and detail (ADR 0039): operator-level `booking.read`, or an agency-scoped `booking.view.agency`; see BookingAccessGuard.
  // Declared before `bookings/:bookingId` so "export" is never read as a booking id. Needs booking.export (operator) or booking.export.agency (agency user) as a formal role.
  @Get('bookings/export') @RequireBookingAction('booking.export', 'booking.export.agency') @UseGuards(BookingAccessGuard)
  async exportBookings(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @BookingAccess() access: BookingAccessView, @Req() req: Request, @Query() query: Q, @Res() res: Response) {
    const file = await this.bookingsRead.exportCsv(tenantId, identity.user.id, access, query, requestIdOf(req))
    // @Res() takes over the response so the global { success, data } envelope never wraps the file; errors thrown above keep the normal JSON envelope.
    res.status(200).set({
      'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${file.filename}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Export-Row-Count': String(file.rowCount),
    }).send(file.csv)
  }

  @Get('bookings') @UseGuards(BookingAccessGuard)
  bookings(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @BookingAccess() access: BookingAccessView, @Req() req: Request, @Query() query: Q) { return this.bookingsRead.list(tenantId, identity.user.id, access, query, requestIdOf(req)) }

  @Get('bookings/:bookingId') @UseGuards(BookingAccessGuard)
  booking(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @BookingAccess() access: BookingAccessView, @Req() req: Request, @Param('bookingId') bookingId: string) { return this.bookingsRead.detail(tenantId, identity.user.id, access, bookingId, requestIdOf(req)) }

  @Get('bookings/:bookingId/documents/:type/html') @RequirePermission('booking.read') @UseGuards(AgentRbacGuard)
  async documentHtml(@ActiveTenant() tenantId: string, @Param('bookingId') bookingId: string, @Param('type') type: string, @Res() response: Response) {
    const html = await this.tx.documentHtml(tenantId, bookingId, type)
    // Headers are set explicitly (not via @Header) because @Res() takes over the response.
    response.status(200).set({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(html)
  }

  @Get('reconciliation') @RequirePermission('booking.reconcile') @UseGuards(AgentRbacGuard)
  reconciliation(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request) { return this.tx.reconciliationQueue(tenantId, identity.user.id, requestIdOf(req)) }

  @Post('reconciliation/run') @RequirePermission('booking.reconcile') @UseGuards(AgentRbacGuard)
  reconcile(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request, @Body() body: ReconcileRequest) { return this.tx.reconcile(tenantId, identity.user.id, requestIdOf(req), body ?? {}) }

  // ---- maker-checker for a reconciliation run (ADR 0017): both sides hold booking.reconcile; the service enforces maker != checker ----
  @Post('reconciliation/approvals') @RequirePermission('booking.reconcile') @UseGuards(AgentRbacGuard)
  requestReconciliationApproval(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: ReconciliationApprovalRequest) { return this.reconApprovals.request(tenantId, identity.user.id, body ?? ({} as ReconciliationApprovalRequest)) }

  @Get('reconciliation/approvals') @RequirePermission('booking.reconcile') @UseGuards(AgentRbacGuard)
  reconciliationApprovals(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Query() query: Q) { return this.reconApprovals.list(tenantId, identity.user.id, query) }

  @Post('reconciliation/approvals/:approvalId/approve') @HttpCode(200) @RequirePermission('booking.reconcile') @RequireStepUp('reconciliation.resolve') @UseGuards(AgentRbacGuard, StepUpGuard)
  approveReconciliation(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('approvalId') approvalId: string, @Body() body: ReconciliationApprovalDecision) { return this.reconApprovals.decide(tenantId, identity.user.id, approvalId, 'APPROVED', body) }

  @Post('reconciliation/approvals/:approvalId/reject') @HttpCode(200) @RequirePermission('booking.reconcile') @UseGuards(AgentRbacGuard)
  rejectReconciliation(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('approvalId') approvalId: string, @Body() body: ReconciliationApprovalDecision) { return this.reconApprovals.decide(tenantId, identity.user.id, approvalId, 'REJECTED', body) }

  @Post('reconciliation/approvals/:approvalId/cancel') @HttpCode(200) @RequirePermission('booking.reconcile') @UseGuards(AgentRbacGuard)
  cancelReconciliationApproval(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('approvalId') approvalId: string) { return this.reconApprovals.cancel(tenantId, identity.user.id, approvalId) }

  @Post('reconciliation/approvals/:approvalId/execute') @HttpCode(200) @RequirePermission('booking.reconcile') @RequireDualApproval('reconciliation.resolve') @UseGuards(AgentRbacGuard, DualApprovalGuard)
  executeReconciliationApproval(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request, @Param('approvalId') approvalId: string) { return this.reconApprovals.execute(tenantId, identity.user.id, approvalId, requestIdOf(req)) }

  @Get('cancellations') @RequirePermission('booking.cancel') @UseGuards(AgentRbacGuard)
  cancellations(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.tx.cancellations(tenantId, query) }

  @Get('wallets') @RequirePermission('finance.read') @UseGuards(AgentRbacGuard)
  wallets(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.tx.wallets(tenantId, query) }

  @Get('ledger') @RequirePermission('finance.read') @UseGuards(AgentRbacGuard)
  ledger(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.tx.ledger(tenantId, query) }

  /** Agency accounts with unpaid charges and their overdue state (ADR 0028 slice 4). Read-only. */
  @Get('credit-notes') @RequirePermission('finance.read') @UseGuards(AgentRbacGuard)
  creditNotes(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.tx.creditNotes(tenantId, query) }

  @Get('supplier-payables') @RequirePermission('finance.read') @UseGuards(AgentRbacGuard)
  supplierPayables(@ActiveTenant() tenantId: string) { return this.tx.supplierPayables(tenantId) }

  @Get('receivables') @RequirePermission('finance.read') @UseGuards(AgentRbacGuard)
  receivables(@ActiveTenant() tenantId: string) { return this.tx.receivables(tenantId) }

  // ADR 0095. Read-only.
  @Get('credit-risk') @RequirePermission('finance.read') @UseGuards(AgentRbacGuard)
  creditRisk(@ActiveTenant() tenantId: string) { return this.tx.creditRisk(tenantId) }

  /** One agency's account position (ADR 0028 slice 1). Read-only; the statement is `ledger?walletId=`. */
  @Get('agencies/:agencyId/account') @RequirePermission('finance.read') @UseGuards(AgentRbacGuard)
  agencyAccount(@ActiveTenant() tenantId: string, @Param('agencyId') agencyId: string) { return this.tx.agencyAccount(tenantId, agencyId) }

  @Get('commercial/impact') @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  markupImpact(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.hotelOps.markupImpact(tenantId, query) }

  @Get('markets/summary') @RequireSupplyPermission('supply.hotels.read') @UseGuards(SupplyPermissionGuard)
  marketsSummary(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.hotelOps.markets(tenantId, query) }

  @Get('reliability/summary') @RequirePermission('booking.read') @UseGuards(AgentRbacGuard)
  reliabilitySummary(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.governance.reliability(tenantId, query) }

  @Get('access-review/summary') @RequirePermission('audit.read') @UseGuards(AgentRbacGuard)
  accessReviewSummary(@ActiveTenant() tenantId: string) { return this.governance.accessReview(tenantId) }

  @Get('access-review/users') @RequirePermission('audit.read') @UseGuards(AgentRbacGuard)
  accessReviewUsers(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.governance.accessReviewUsers(tenantId, query) }

  @Get('compliance/summary') @RequirePermission('audit.read') @UseGuards(AgentRbacGuard)
  complianceSummary(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.compliance.summary(tenantId, query) }

  @Get('compliance/records') @RequirePermission('audit.read') @UseGuards(AgentRbacGuard)
  complianceRecords(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.compliance.records(tenantId, query) }

  /** A file download (JSON or CSV), audited as compliance.report.exported. Errors keep the normal JSON envelope. */
  @Get('compliance/report') @RequirePermission('audit.read') @UseGuards(AgentRbacGuard)
  async complianceReport(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Query() query: Q, @Req() req: Request, @Res() res: Response) {
    const { report, format } = await this.compliance.report(tenantId, identity.user.id, requestIdOf(req), query)
    const name = `compliance-report-${report.period.from}-to-${report.period.to}.${format}`
    res.status(200).set({
      'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Compliance-Records': String(report.attestation.recordCount), 'X-Compliance-Records-Sha256': report.attestation.recordsSha256,
    }).send(format === 'csv' ? complianceReportCsv(report) : JSON.stringify(report, null, 2))
  }

  @Get('finance/summary') @RequirePermission('finance.read') @UseGuards(AgentRbacGuard)
  financeSummary(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.finAudit.financeSummary(tenantId, query) }

  /** Ledger integrity and sub-ledger reconciliation (ADR 0068). Read-only; posts, corrects and locks nothing. */
  @Get('finance/ledger-integrity') @RequirePermission('finance.read') @UseGuards(AgentRbacGuard)
  ledgerIntegrity(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.integrity.report(tenantId, query) }

  /**
   * Settles cancelled, charged bookings that have no refund yet (ADR 0069), per their effective penalty. The amounts are fixed by policy or by
   * a recorded decision, never by this request; `dryRun` lists what would be settled. Idempotent, so it can be run as often as needed.
   */
  @Post('finance/cancellation-settlements') @HttpCode(200) @RequirePermission('booking.reconcile') @UseGuards(AgentRbacGuard)
  cancellationSettlements(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: CancellationSettlementRequest | undefined, @Req() req: Request) {
    return this.settlement.sweep({ tenantId, userId: identity.user.id, requestId: requestIdOf(req), dryRun: body?.dryRun === true })
  }

  @Get('audit/summary') @RequirePermission('audit.read') @UseGuards(AgentRbacGuard)
  auditSummary(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.finAudit.auditSummary(tenantId, query) }

  @Get('audit') @RequirePermission('audit.read') @UseGuards(AgentRbacGuard)
  audit(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.tx.audit(tenantId, query) }

  @Get('connectors') @RequirePermission('booking.read') @UseGuards(AgentRbacGuard)
  connectors(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.tx.connectors(tenantId, query) }
}
