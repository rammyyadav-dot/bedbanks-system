import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { randomUUID } from 'node:crypto'
import type { Request, Response } from 'express'
import { departmentPermissions, operationsPermissions, type DepartmentPermission, type OperationsCapabilities, type OperationsPermission, type ReconcileRequest, type ReconciliationApprovalDecision, type ReconciliationApprovalRequest } from '@bedbanks/contracts'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { AgentRbacGuard, RequirePermission } from '../agent/rbac.guard'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { PrismaService } from '../database/prisma.service'
import { OperationsHotelsService } from './operations-hotels.service'
import { OperationsFinanceAuditService } from './operations-finance-audit.service'
import { OperationsReconciliationApprovalsService } from './operations-reconciliation-approvals.service'
import { OperationsGovernanceService } from './operations-governance.service'
import { OperationsSupplyService } from './operations-supply.service'
import { RequireSupplyPermission, SupplyPermissionGuard } from './supply-permission.guard'
import { OperationsTransactionsService } from './operations-transactions.service'

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
  constructor(private readonly prisma: PrismaService, private readonly supply: OperationsSupplyService, private readonly tx: OperationsTransactionsService, private readonly hotelOps: OperationsHotelsService, private readonly finAudit: OperationsFinanceAuditService, private readonly reconApprovals: OperationsReconciliationApprovalsService, private readonly governance: OperationsGovernanceService) {}

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

  @Get('readiness') @RequirePermission('booking.read') @UseGuards(AgentRbacGuard)
  readiness(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Query() query: Q) {
    return this.supply.readiness(tenantId, identity.user.id, query, () => this.tx.transactionSummary(tenantId), () => this.tx.connectorSummary(tenantId))
  }

  // ---- hotel commercial operations: existing supply.* permissions, formal roles only (same rule as /supply) ------------------
  @Get('hotels') @RequireSupplyPermission('supply.hotels.read') @UseGuards(SupplyPermissionGuard)
  hotels(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.hotelOps.list(tenantId, query) }

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

  @Get('bookings') @RequirePermission('booking.read') @UseGuards(AgentRbacGuard)
  bookings(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.tx.bookings(tenantId, query) }

  @Get('bookings/:bookingId') @RequirePermission('booking.read') @UseGuards(AgentRbacGuard)
  booking(@ActiveTenant() tenantId: string, @Param('bookingId') bookingId: string) { return this.tx.booking(tenantId, bookingId) }

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

  @Post('reconciliation/approvals/:approvalId/approve') @HttpCode(200) @RequirePermission('booking.reconcile') @UseGuards(AgentRbacGuard)
  approveReconciliation(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('approvalId') approvalId: string, @Body() body: ReconciliationApprovalDecision) { return this.reconApprovals.decide(tenantId, identity.user.id, approvalId, 'APPROVED', body) }

  @Post('reconciliation/approvals/:approvalId/reject') @HttpCode(200) @RequirePermission('booking.reconcile') @UseGuards(AgentRbacGuard)
  rejectReconciliation(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('approvalId') approvalId: string, @Body() body: ReconciliationApprovalDecision) { return this.reconApprovals.decide(tenantId, identity.user.id, approvalId, 'REJECTED', body) }

  @Post('reconciliation/approvals/:approvalId/cancel') @HttpCode(200) @RequirePermission('booking.reconcile') @UseGuards(AgentRbacGuard)
  cancelReconciliationApproval(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('approvalId') approvalId: string) { return this.reconApprovals.cancel(tenantId, identity.user.id, approvalId) }

  @Post('reconciliation/approvals/:approvalId/execute') @HttpCode(200) @RequirePermission('booking.reconcile') @UseGuards(AgentRbacGuard)
  executeReconciliationApproval(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request, @Param('approvalId') approvalId: string) { return this.reconApprovals.execute(tenantId, identity.user.id, approvalId, requestIdOf(req)) }

  @Get('cancellations') @RequirePermission('booking.cancel') @UseGuards(AgentRbacGuard)
  cancellations(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.tx.cancellations(tenantId, query) }

  @Get('wallets') @RequirePermission('finance.read') @UseGuards(AgentRbacGuard)
  wallets(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.tx.wallets(tenantId, query) }

  @Get('ledger') @RequirePermission('finance.read') @UseGuards(AgentRbacGuard)
  ledger(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.tx.ledger(tenantId, query) }

  /** Agency accounts with unpaid charges and their overdue state (ADR 0028 slice 4). Read-only. */
  @Get('receivables') @RequirePermission('finance.read') @UseGuards(AgentRbacGuard)
  receivables(@ActiveTenant() tenantId: string) { return this.tx.receivables(tenantId) }

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

  @Get('finance/summary') @RequirePermission('finance.read') @UseGuards(AgentRbacGuard)
  financeSummary(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.finAudit.financeSummary(tenantId, query) }

  @Get('audit/summary') @RequirePermission('audit.read') @UseGuards(AgentRbacGuard)
  auditSummary(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.finAudit.auditSummary(tenantId, query) }

  @Get('audit') @RequirePermission('audit.read') @UseGuards(AgentRbacGuard)
  audit(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.tx.audit(tenantId, query) }

  @Get('connectors') @RequirePermission('booking.read') @UseGuards(AgentRbacGuard)
  connectors(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.tx.connectors(tenantId, query) }
}
