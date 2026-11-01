import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { AgentRbacGuard, RequirePermission } from '../agent/rbac.guard'
import { PERMISSIONS } from '../agent/supplier.port'
import { RequireDepartmentPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { CreditNoteService } from './credit-note.service'

/**
 * Partial credit notes (ADR 0095 part B). Reads need finance.read. Proposing needs finance.creditnote.propose and approving or rejecting needs finance.creditnote.approve, both from a
 * formal role; the service refuses a decision by the proposer. Tenant identity comes from the session only.
 */
@ApiTags('admin-credit-notes')
@Controller('admin/finance/credit-notes')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class CreditNoteController {
  constructor(private readonly notes: CreditNoteService) {}

  @Get() @RequirePermission(PERMISSIONS.viewFinance) @UseGuards(AgentRbacGuard)
  list(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Query() query: Record<string, unknown>) { return this.notes.list(tenantId, identity.user.id, query) }

  @Post() @HttpCode(200) @RequireDepartmentPermission('finance.creditnote.propose') @UseGuards(SupplyPermissionGuard)
  propose(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: unknown) { return this.notes.propose(tenantId, identity.user.id, body) }

  @Post(':creditNoteId/approve') @HttpCode(200) @RequireDepartmentPermission('finance.creditnote.approve') @UseGuards(SupplyPermissionGuard)
  approve(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('creditNoteId') creditNoteId: string) { return this.notes.approve(tenantId, identity.user.id, creditNoteId) }

  @Post(':creditNoteId/reject') @HttpCode(200) @RequireDepartmentPermission('finance.creditnote.approve') @UseGuards(SupplyPermissionGuard)
  reject(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('creditNoteId') creditNoteId: string, @Body() body: unknown) { return this.notes.reject(tenantId, identity.user.id, creditNoteId, body) }
}
