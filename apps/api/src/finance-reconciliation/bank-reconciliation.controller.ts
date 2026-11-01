import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import type { BankExceptionResolveRequest, BankStatementImportRequest } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { AgentRbacGuard, RequirePermission } from '../agent/rbac.guard'
import { PERMISSIONS } from '../agent/supplier.port'
import { RequireDepartmentPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { BankReconciliationService } from './bank-reconciliation.service'
import { RequireStepUp, StepUpGuard } from '../approvals/dual-approval.guard'

type Q = Record<string, unknown>

/**
 * Bank statement reconciliation (ADR 0093). Reads need finance.read. Importing a statement needs finance.reconcile.run and closing an exception needs
 * finance.reconcile.resolve, both from a formal role; the service adds separation of duties and the deployment flag. Tenant identity comes from the session only.
 */
@ApiTags('admin-bank-reconciliation')
@Controller('admin/finance/bank-reconciliation')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class BankReconciliationController {
  constructor(private readonly bank: BankReconciliationService) {}

  @Get('statements') @RequirePermission(PERMISSIONS.viewFinance) @UseGuards(AgentRbacGuard)
  statements(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.bank.listStatements(tenantId, query) }

  @Get('statements/:statementId') @RequirePermission(PERMISSIONS.viewFinance) @UseGuards(AgentRbacGuard)
  statement(@ActiveTenant() tenantId: string, @Param('statementId') statementId: string) { return this.bank.getStatement(tenantId, statementId) }

  @Post('statements') @HttpCode(200) @RequireDepartmentPermission('finance.reconcile.run') @UseGuards(SupplyPermissionGuard)
  importStatement(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: BankStatementImportRequest) { return this.bank.importStatement(tenantId, identity.user.id, body) }

  @Get('exceptions') @RequirePermission(PERMISSIONS.viewFinance) @UseGuards(AgentRbacGuard)
  exceptions(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Query() query: Q) { return this.bank.listExceptions(tenantId, identity.user.id, query) }

  @Post('exceptions/:exceptionId/resolve') @HttpCode(200) @RequireDepartmentPermission('finance.reconcile.resolve') @RequireStepUp('finance.reconcile.resolve', 'exceptionId') @UseGuards(SupplyPermissionGuard, StepUpGuard)
  resolve(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('exceptionId') exceptionId: string, @Body() body: BankExceptionResolveRequest) { return this.bank.resolveException(tenantId, identity.user.id, exceptionId, body) }
}
