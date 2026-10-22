import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { ActiveSupplier, SupplierOrganizationGuard } from './supplier-organization.guard'
import { RequireSupplierPermission, SupplierPermissionGuard } from './supplier-permission.guard'
import { SupplierChangeSetsService } from './supplier-change-sets.service'
import { ChangeSetTransitionDto, CreateChangeSetDto, ListChangeSetsQueryDto, ReplaceChangeSetDto } from './change-set.dto'

/** Availability change sets (ADR 0061 Amendment 3). Every route is scoped to the caller's active supplier organization. */
@Controller('supplier/extranet/change-sets')
@UseGuards(SessionAuthGuard, TenantContextGuard, SupplierOrganizationGuard, SupplierPermissionGuard)
export class SupplierChangeSetsController {
  constructor(private readonly changeSets: SupplierChangeSetsService) {}

  @Get()
  @RequireSupplierPermission('supplier.extranet.changes.read')
  list(@ActiveTenant() tenantId: string, @ActiveSupplier() supplierId: string, @CurrentUser() identity: AuthenticatedUser, @Query() query: ListChangeSetsQueryDto) {
    return this.changeSets.list(tenantId, identity.user.id, supplierId, query)
  }

  @Post('preview')
  @RequireSupplierPermission('supplier.extranet.changes.author')
  @HttpCode(200)
  preview(@ActiveTenant() tenantId: string, @ActiveSupplier() supplierId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: CreateChangeSetDto) {
    return this.changeSets.preview(tenantId, identity.user.id, supplierId, body)
  }

  @Post()
  @RequireSupplierPermission('supplier.extranet.changes.author')
  create(@Req() request: Request, @ActiveTenant() tenantId: string, @ActiveSupplier() supplierId: string, @CurrentUser() identity: AuthenticatedUser, @Headers('idempotency-key') key: string | undefined, @Body() body: CreateChangeSetDto) {
    return this.changeSets.create(tenantId, identity.user.id, supplierId, body, key, request.requestId)
  }

  @Get(':changeSetId')
  @RequireSupplierPermission('supplier.extranet.changes.read')
  detail(@ActiveTenant() tenantId: string, @ActiveSupplier() supplierId: string, @CurrentUser() identity: AuthenticatedUser, @Param('changeSetId') changeSetId: string) {
    return this.changeSets.detail(tenantId, identity.user.id, supplierId, changeSetId)
  }

  @Put(':changeSetId')
  @RequireSupplierPermission('supplier.extranet.changes.author')
  @HttpCode(200)
  replace(@Req() request: Request, @ActiveTenant() tenantId: string, @ActiveSupplier() supplierId: string, @CurrentUser() identity: AuthenticatedUser, @Param('changeSetId') changeSetId: string, @Headers('idempotency-key') key: string | undefined, @Body() body: ReplaceChangeSetDto) {
    return this.changeSets.replace(tenantId, identity.user.id, supplierId, changeSetId, body, key, request.requestId)
  }

  @Post(':changeSetId/submit')
  @RequireSupplierPermission('supplier.extranet.changes.author')
  @HttpCode(200)
  submit(@Req() request: Request, @ActiveTenant() tenantId: string, @ActiveSupplier() supplierId: string, @CurrentUser() identity: AuthenticatedUser, @Param('changeSetId') changeSetId: string, @Headers('idempotency-key') key: string | undefined, @Body() body: ChangeSetTransitionDto) {
    return this.changeSets.submit(tenantId, identity.user.id, supplierId, changeSetId, body, key, request.requestId)
  }

  @Post(':changeSetId/withdraw')
  @RequireSupplierPermission('supplier.extranet.changes.author')
  @HttpCode(200)
  withdraw(@Req() request: Request, @ActiveTenant() tenantId: string, @ActiveSupplier() supplierId: string, @CurrentUser() identity: AuthenticatedUser, @Param('changeSetId') changeSetId: string, @Headers('idempotency-key') key: string | undefined, @Body() body: ChangeSetTransitionDto) {
    return this.changeSets.withdraw(tenantId, identity.user.id, supplierId, changeSetId, body, key, request.requestId)
  }
}
