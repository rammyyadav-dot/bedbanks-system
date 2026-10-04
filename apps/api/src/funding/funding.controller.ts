import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import type { FundingDeclareRequest, FundingNoteRequest, FundingRejectRequest } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { AgentRbacGuard, RequirePermission } from '../agent/rbac.guard'
import { PERMISSIONS } from '../agent/supplier.port'
import { RequireDepartmentPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { FundingService } from './funding.service'

type Q = Record<string, unknown>

/**
 * Admin funding receipts (ADR 0028 slice 2). Reads need finance.read; every step needs funding.manage from a formal role, and the service
 * adds separation of duties (declarer, verifier, compliance reviewer and poster; a second person above the threshold).
 */
@ApiTags('admin-funding')
@Controller('admin/funding')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class FundingController {
  constructor(private readonly funding: FundingService) {}

  @Get('receipts') @RequirePermission(PERMISSIONS.viewFinance) @UseGuards(AgentRbacGuard)
  list(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Query() query: Q) { return this.funding.list(tenantId, identity.user.id, query) }

  @Get('receipts/:receiptId') @RequirePermission(PERMISSIONS.viewFinance) @UseGuards(AgentRbacGuard)
  get(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('receiptId') receiptId: string) { return this.funding.get(tenantId, identity.user.id, receiptId) }

  @Post('receipts') @HttpCode(200) @RequireDepartmentPermission('funding.manage') @UseGuards(SupplyPermissionGuard)
  declare(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: FundingDeclareRequest) { return this.funding.adminDeclare(tenantId, identity.user.id, body) }

  @Post('receipts/:receiptId/verify') @HttpCode(200) @RequireDepartmentPermission('funding.manage') @UseGuards(SupplyPermissionGuard)
  verify(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('receiptId') receiptId: string, @Body() body: FundingNoteRequest) { return this.funding.verify(tenantId, identity.user.id, receiptId, body) }

  @Post('receipts/:receiptId/clear-compliance') @HttpCode(200) @RequireDepartmentPermission('funding.manage') @UseGuards(SupplyPermissionGuard)
  clearCompliance(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('receiptId') receiptId: string, @Body() body: FundingNoteRequest) { return this.funding.clearCompliance(tenantId, identity.user.id, receiptId, body) }

  @Post('receipts/:receiptId/post') @HttpCode(200) @RequireDepartmentPermission('funding.manage') @UseGuards(SupplyPermissionGuard)
  post(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('receiptId') receiptId: string) { return this.funding.post(tenantId, identity.user.id, receiptId) }

  @Post('receipts/:receiptId/reject') @HttpCode(200) @RequireDepartmentPermission('funding.manage') @UseGuards(SupplyPermissionGuard)
  reject(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('receiptId') receiptId: string, @Body() body: FundingRejectRequest) { return this.funding.reject(tenantId, identity.user.id, receiptId, body) }
}

/** The agency's own side: declare a payment for the caller's agency and see its receipts. Nothing here verifies or posts. */
@ApiTags('agent-funding')
@Controller('agent/funding')
@UseGuards(SessionAuthGuard, TenantContextGuard, AgentRbacGuard)
export class AgentFundingController {
  constructor(private readonly funding: FundingService) {}

  @Get('receipts') @RequirePermission(PERMISSIONS.prebook)
  list(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser) { return this.funding.agentReceipts(tenantId, identity.user.id) }

  @Post('receipts') @HttpCode(200) @RequirePermission(PERMISSIONS.prebook)
  declare(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: FundingDeclareRequest) { return this.funding.agentDeclare(tenantId, identity.user.id, body) }
}
