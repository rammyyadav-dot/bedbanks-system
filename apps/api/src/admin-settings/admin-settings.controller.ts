import { Body, Controller, Get, Headers, Patch, Query, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { AdminRbacGuard, RequireAdminPermission } from '../auth/admin-rbac.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { AdminSettingsService } from './admin-settings.service'
import { SettingsQueryDto, UpdateTenantSettingsDto } from './dto/update-tenant-settings.dto'

@Controller('admin/settings')
@UseGuards(SessionAuthGuard, AdminRbacGuard)
export class AdminSettingsController {
  constructor(private readonly settings: AdminSettingsService) {}

  @Get()
  @RequireAdminPermission('settings.manage')
  getSettings(@CurrentUser() identity: AuthenticatedUser, @Query() _query: SettingsQueryDto) {
    return this.settings.getSettings(identity)
  }

  @Patch()
  @RequireAdminPermission('settings.manage')
  updateSettings(
    @CurrentUser() identity: AuthenticatedUser,
    @Body() body: UpdateTenantSettingsDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    return this.settings.updateSettings(identity, body, idempotencyKey, request.header('x-request-id') ?? undefined)
  }
}
