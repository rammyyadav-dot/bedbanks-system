import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { PlatformRbacGuard } from './platform-rbac.guard'
import { RequirePlatformPermission } from './platform-admin'
import { PlatformAdminService } from './platform-admin.service'

@Controller('platform')
@UseGuards(SessionAuthGuard, PlatformRbacGuard)
export class PlatformAdminController {
  constructor(private readonly platform: PlatformAdminService) {}

  @Get('tenants')
  @RequirePlatformPermission('platform.tenants.read')
  listTenants(@CurrentUser() identity: AuthenticatedUser, @Req() request: Request) {
    return this.platform.listTenants(identity.user.id, request.header('x-request-id') ?? undefined)
  }

  @Get('tenants/:tenantId/summary')
  @RequirePlatformPermission('platform.tenants.access')
  getTenantSummary(@CurrentUser() identity: AuthenticatedUser, @Param('tenantId') tenantId: string, @Req() request: Request) {
    return this.platform.getTenantSummary({ operatorUserId: identity.user.id, targetTenantId: tenantId, permission: 'platform.tenants.access', requestId: request.header('x-request-id') ?? undefined })
  }
}
