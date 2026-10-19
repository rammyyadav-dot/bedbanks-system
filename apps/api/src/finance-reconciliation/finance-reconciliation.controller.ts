import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UnsupportedMediaTypeException, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { ApiTags } from '@nestjs/swagger'
import { STATEMENT_STREAM_CONTENT_TYPE, type ReconDecisionRequest, type ReconProposeRequest, type ReconRunRequest, type StatementImportRequest } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { AgentRbacGuard, RequirePermission } from '../agent/rbac.guard'
import { PERMISSIONS } from '../agent/supplier.port'
import { RequireDepartmentPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { ReconciliationService } from './reconciliation.service'

type Q = Record<string, unknown>

/**
 * Supplier statement reconciliation and the dispute queue (ADR 0070). Reads need finance.read. Importing a statement and requesting a run need
 * finance.reconcile.run; every decision needs finance.reconcile.resolve, both from a formal role. The service adds separation of duties and the
 * deployment flag. Tenant identity comes from the session only.
 */
@ApiTags('admin-finance-reconciliation')
@Controller('admin/finance/reconciliation')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class FinanceReconciliationController {
  constructor(private readonly recon: ReconciliationService) {}

  @Get('statements') @RequirePermission(PERMISSIONS.viewFinance) @UseGuards(AgentRbacGuard)
  statements(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.recon.listStatements(tenantId, query) }

  @Get('statements/:statementId') @RequirePermission(PERMISSIONS.viewFinance) @UseGuards(AgentRbacGuard)
  statement(@ActiveTenant() tenantId: string, @Param('statementId') statementId: string) { return this.recon.getStatement(tenantId, statementId) }

  @Post('statements') @HttpCode(200) @RequireDepartmentPermission('finance.reconcile.run') @UseGuards(SupplyPermissionGuard)
  importStatement(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: StatementImportRequest) { return this.recon.importStatement(tenantId, identity.user.id, body) }

  // ADR 0074. Declared before the parameterised statement routes. The guards above run before a byte of the body is read; the body is then consumed as a stream.
  @Post('statements/stream') @HttpCode(200) @RequireDepartmentPermission('finance.reconcile.run') @UseGuards(SupplyPermissionGuard)
  importStatementStream(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request) {
    if (!req.is(STATEMENT_STREAM_CONTENT_TYPE)) throw new UnsupportedMediaTypeException(`Content-Type must be ${STATEMENT_STREAM_CONTENT_TYPE}`)
    return this.recon.importStatementStream(tenantId, identity.user.id, req)
  }

  @Post('statements/:statementId/runs') @HttpCode(200) @RequireDepartmentPermission('finance.reconcile.run') @UseGuards(SupplyPermissionGuard)
  run(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('statementId') statementId: string, @Body() body: ReconRunRequest) { return this.recon.enqueueRun(tenantId, identity.user.id, statementId, body) }

  @Get('exceptions') @RequirePermission(PERMISSIONS.viewFinance) @UseGuards(AgentRbacGuard)
  exceptions(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Query() query: Q) { return this.recon.listExceptions(tenantId, identity.user.id, query) }

  @Get('exceptions/summary') @RequirePermission(PERMISSIONS.viewFinance) @UseGuards(AgentRbacGuard)
  summary(@ActiveTenant() tenantId: string) { return this.recon.exceptionSummary(tenantId) }

  @Get('exceptions/:exceptionId') @RequirePermission(PERMISSIONS.viewFinance) @UseGuards(AgentRbacGuard)
  exception(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('exceptionId') exceptionId: string) { return this.recon.getException(tenantId, identity.user.id, exceptionId) }

  @Post('exceptions/:exceptionId/propose') @HttpCode(200) @RequireDepartmentPermission('finance.reconcile.resolve') @UseGuards(SupplyPermissionGuard)
  propose(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('exceptionId') exceptionId: string, @Body() body: ReconProposeRequest) { return this.recon.proposeDecision(tenantId, identity.user.id, exceptionId, body) }

  @Post('exceptions/:exceptionId/approve') @HttpCode(200) @RequireDepartmentPermission('finance.reconcile.resolve') @UseGuards(SupplyPermissionGuard)
  approve(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('exceptionId') exceptionId: string, @Body() body: ReconDecisionRequest) { return this.recon.approveDecision(tenantId, identity.user.id, exceptionId, body) }

  @Post('exceptions/:exceptionId/reject') @HttpCode(200) @RequireDepartmentPermission('finance.reconcile.resolve') @UseGuards(SupplyPermissionGuard)
  reject(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('exceptionId') exceptionId: string, @Body() body: ReconDecisionRequest) { return this.recon.rejectDecision(tenantId, identity.user.id, exceptionId, body) }
}
