import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { ApiTags } from '@nestjs/swagger'
import type { SupplierTermsSetRequest } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { AgentRbacGuard, RequirePermission } from '../agent/rbac.guard'
import { PERMISSIONS } from '../agent/supplier.port'
import { RequireDepartmentPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { SupplierTermsService } from './supplier-terms.service'

/** Supplier payment terms (ADR 0078). Reads need finance.read; setting terms needs finance.terms.manage from a formal role. Tenant identity comes from the session only. */
@ApiTags('admin-supplier-terms')
@Controller('admin/finance/supplier-terms')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class SupplierTermsController {
  constructor(private readonly terms: SupplierTermsService) {}

  @Get() @RequirePermission(PERMISSIONS.viewFinance) @UseGuards(AgentRbacGuard)
  list(@ActiveTenant() tenantId: string) { return this.terms.list(tenantId) }

  @Post() @HttpCode(200) @RequireDepartmentPermission('finance.terms.manage') @UseGuards(SupplyPermissionGuard)
  set(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: SupplierTermsSetRequest, @Req() req: Request) {
    return this.terms.set(tenantId, identity.user.id, body, String((req as Request & { id?: string }).id ?? req.headers['x-request-id'] ?? 'unknown').slice(0, 80))
  }
}
