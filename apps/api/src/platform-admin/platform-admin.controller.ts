import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { OriginGuard } from '../auth/guards/origin.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { PlatformRbacGuard } from './platform-rbac.guard'
import { RequirePlatformPermission } from './platform-admin'
import { TenantControlService } from './tenant-control.service'
import { ComplianceDecisionDto, CreateTenantDto, LifecycleDecisionDto, LifecycleRequestDto, MembershipChangeDto, TenantAuditDto, TenantDirectoryDto, UpdateTenantProfileDto } from './tenant-control.dto'

@Controller('platform')
@UseGuards(SessionAuthGuard, OriginGuard, PlatformRbacGuard)
export class PlatformAdminController {
  constructor(private readonly control: TenantControlService) {}
  @Get('tenants') @RequirePlatformPermission('platform.tenants.read')
  list(@CurrentUser() u: AuthenticatedUser, @Query() q: TenantDirectoryDto, @Req() r: Request) { return this.control.directory(u.user.id, q, r.header('x-request-id')) }
  @Get('tenants/:tenantId/summary') @RequirePlatformPermission('platform.tenants.access')
  detail(@CurrentUser() u: AuthenticatedUser, @Param('tenantId') id: string) { return this.control.detail(u.user.id, id) }
  @Post('tenants') @RequirePlatformPermission('platform.tenants.create')
  create(@CurrentUser() u: AuthenticatedUser, @Body() b: CreateTenantDto, @Headers('idempotency-key') k?: string) { return this.control.create(u.user.id, b, k) }
  @Patch('tenants/:tenantId/profile') @RequirePlatformPermission('platform.tenants.manage')
  profile(@CurrentUser() u: AuthenticatedUser, @Param('tenantId') id: string, @Body() b: UpdateTenantProfileDto, @Headers('idempotency-key') k?: string) { return this.control.updateProfile(u.user.id, id, b, k) }
  @Post('tenants/:tenantId/memberships') @RequirePlatformPermission('platform.tenants.memberships.manage')
  member(@CurrentUser() u: AuthenticatedUser, @Param('tenantId') id: string, @Body() b: MembershipChangeDto, @Headers('idempotency-key') k?: string) { return this.control.membership(u.user.id, id, b, k) }
  @Post('tenants/:tenantId/compliance') @RequirePlatformPermission('platform.tenants.compliance.approve')
  compliance(@CurrentUser() u: AuthenticatedUser, @Param('tenantId') id: string, @Body() b: ComplianceDecisionDto, @Headers('idempotency-key') k?: string) { return this.control.compliance(u.user.id, id, b, k) }
  @Post('tenants/:tenantId/lifecycle') @RequirePlatformPermission('platform.tenants.lifecycle.request')
  lifecycle(@CurrentUser() u: AuthenticatedUser, @Param('tenantId') id: string, @Body() b: LifecycleRequestDto, @Headers('idempotency-key') k?: string) { return this.control.requestLifecycle(u.user.id, id, b, k) }
  @Post('tenants/:tenantId/approvals/:approvalId') @RequirePlatformPermission('platform.tenants.lifecycle.approve')
  decide(@CurrentUser() u: AuthenticatedUser, @Param('tenantId') id: string, @Param('approvalId') approval: string, @Body() b: LifecycleDecisionDto) { return this.control.decideLifecycle(u.user.id, id, approval, b) }
  @Get('tenants/:tenantId/audit') @RequirePlatformPermission('platform.tenants.audit.read')
  audit(@CurrentUser() u: AuthenticatedUser, @Param('tenantId') id: string, @Query() q: TenantAuditDto) { return this.control.auditEvents(u.user.id, id, q) }
}
