import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common'
import type { RestrictionCreate } from '@bedbanks/contracts'
import { ApiTags } from '@nestjs/swagger'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { RequireDepartmentPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { DistributionService } from './distribution.service'

type Q = Record<string, unknown>

/** Distribution restrictions (ADR 0019). Reads need distribution.read, changes distribution.manage. */
@ApiTags('admin-distribution')
@Controller('admin/distribution')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class DistributionController {
  constructor(private readonly distribution: DistributionService) {}

  @Get('summary') @RequireDepartmentPermission('distribution.read') @UseGuards(SupplyPermissionGuard)
  summary(@ActiveTenant() tenantId: string) { return this.distribution.summary(tenantId) }

  @Get('restrictions') @RequireDepartmentPermission('distribution.read') @UseGuards(SupplyPermissionGuard)
  list(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.distribution.list(tenantId, query) }

  @Post('restrictions') @RequireDepartmentPermission('distribution.manage') @UseGuards(SupplyPermissionGuard)
  create(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: RestrictionCreate) { return this.distribution.create(tenantId, identity.user.id, body ?? ({} as RestrictionCreate)) }

  @Post('restrictions/:restrictionId/retire') @HttpCode(200) @RequireDepartmentPermission('distribution.manage') @UseGuards(SupplyPermissionGuard)
  retire(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('restrictionId') restrictionId: string) { return this.distribution.retire(tenantId, identity.user.id, restrictionId) }
}
