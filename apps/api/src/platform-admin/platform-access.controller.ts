import { Body, Controller, Delete, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { AssignPlatformRoleDto, CreatePlatformRoleDto, SetRolePermissionsDto } from './platform-access.dto'
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
  @RequirePlatformPermission('platform.roles.read')
  listPermissions(@CurrentUser() identity: AuthenticatedUser) { return this.access.listPermissions(identity.user.id) }

  @Get('roles')
  @RequirePlatformPermission('platform.roles.read')
  listRoles(@CurrentUser() identity: AuthenticatedUser) { return this.access.listRoles(identity.user.id) }

  @Get('assignments')
  @RequirePlatformPermission('platform.assignments.read')
  listAssignments(@CurrentUser() identity: AuthenticatedUser) { return this.access.listAssignments(identity.user.id) }

  @Post('roles')
  @RequirePlatformPermission('platform.roles.manage')
  createRole(@CurrentUser() identity: AuthenticatedUser, @Req() request: Request, @Body() body: CreatePlatformRoleDto) { return this.access.createRole(identity.user.id, body, request.header('x-request-id') ?? undefined) }

  @Put('roles/:roleId')
  @RequirePlatformPermission('platform.roles.manage')
  updateRole(@CurrentUser() identity: AuthenticatedUser, @Req() request: Request, @Param('roleId') roleId: string, @Body() body: CreatePlatformRoleDto) { return this.access.updateRole(identity.user.id, roleId, body, request.header('x-request-id') ?? undefined) }

  @Put('roles/:roleId/permissions')
  @RequirePlatformPermission('platform.roles.manage')
  setRolePermissions(@CurrentUser() identity: AuthenticatedUser, @Req() request: Request, @Param('roleId') roleId: string, @Body() body: SetRolePermissionsDto) { return this.access.setRolePermissions(identity.user.id, roleId, body.permissionIds, request.header('x-request-id') ?? undefined) }

  @Post('assignments')
  @RequirePlatformPermission('platform.assignments.manage')
  assignRole(@CurrentUser() identity: AuthenticatedUser, @Req() request: Request, @Body() body: AssignPlatformRoleDto) { return this.access.assignRole(identity.user.id, body, request.header('x-request-id') ?? undefined) }

  @Delete('assignments/:userId/:roleId')
  @RequirePlatformPermission('platform.assignments.manage')
  revokeRole(@CurrentUser() identity: AuthenticatedUser, @Req() request: Request, @Param('userId') userId: string, @Param('roleId') roleId: string) { return this.access.revokeRole(identity.user.id, { userId, roleId }, request.header('x-request-id') ?? undefined) }
}
