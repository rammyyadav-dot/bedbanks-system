import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { PlatformRbacGuard } from './platform-rbac.guard'
import { RequirePlatformPermission } from './platform-admin'
import { PlatformAccessService } from './platform-access.service'

@Controller('platform/access')
@UseGuards(SessionAuthGuard, PlatformRbacGuard)
export class PlatformAccessController {
  constructor(private readonly access: PlatformAccessService) {}

  @Get('permissions')
  @RequirePlatformPermission('platform.access.read')
  listPermissions(@CurrentUser() identity: AuthenticatedUser) { return this.access.listPermissions(identity.user.id) }

  @Get('roles')
  @RequirePlatformPermission('platform.access.read')
  listRoles(@CurrentUser() identity: AuthenticatedUser) { return this.access.listRoles(identity.user.id) }

  @Get('assignments')
  @RequirePlatformPermission('platform.access.read')
  listAssignments(@CurrentUser() identity: AuthenticatedUser) { return this.access.listAssignments(identity.user.id) }

  @Post('roles')
  @RequirePlatformPermission('platform.access.manage')
  createRole(@CurrentUser() identity: AuthenticatedUser, @Body() body: { id: string; name: string; description?: string }) { return this.access.createRole(identity.user.id, body) }

  @Put('roles/:roleId/permissions')
  @RequirePlatformPermission('platform.access.manage')
  setRolePermissions(@CurrentUser() identity: AuthenticatedUser, @Param('roleId') roleId: string, @Body() body: { permissionIds: string[] }) { return this.access.setRolePermissions(identity.user.id, roleId, body.permissionIds) }

  @Post('assignments')
  @RequirePlatformPermission('platform.access.manage')
  assignRole(@CurrentUser() identity: AuthenticatedUser, @Body() body: { userId: string; roleId: string }) { return this.access.assignRole(identity.user.id, body) }

  @Delete('assignments/:userId/:roleId')
  @RequirePlatformPermission('platform.access.manage')
  revokeRole(@CurrentUser() identity: AuthenticatedUser, @Param('userId') userId: string, @Param('roleId') roleId: string) { return this.access.revokeRole(identity.user.id, { userId, roleId }) }
}
