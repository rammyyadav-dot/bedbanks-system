import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common'
import type { CaseAssign, CaseCreate, CaseNoteCreate, CaseTransition } from '@bedbanks/contracts'
import { ApiTags } from '@nestjs/swagger'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { RequireDepartmentPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { ServiceCasesService } from './service-cases.service'

type Q = Record<string, unknown>

/** Service cases (ADR 0019). Reads need case.read, every change case.manage. */
@ApiTags('admin-service')
@Controller('admin/service')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class ServiceCasesController {
  constructor(private readonly cases: ServiceCasesService) {}

  @Get('summary') @RequireDepartmentPermission('case.read') @UseGuards(SupplyPermissionGuard)
  summary(@ActiveTenant() tenantId: string) { return this.cases.summary(tenantId) }

  @Get('assignees') @RequireDepartmentPermission('case.read') @UseGuards(SupplyPermissionGuard)
  assignees(@ActiveTenant() tenantId: string) { return this.cases.assignees(tenantId) }

  @Get('cases') @RequireDepartmentPermission('case.read') @UseGuards(SupplyPermissionGuard)
  list(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Query() query: Q) { return this.cases.list(tenantId, identity.user.id, query) }

  @Post('cases') @RequireDepartmentPermission('case.manage') @UseGuards(SupplyPermissionGuard)
  create(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: CaseCreate) { return this.cases.create(tenantId, identity.user.id, body ?? ({} as CaseCreate)) }

  @Get('cases/:caseId') @RequireDepartmentPermission('case.read') @UseGuards(SupplyPermissionGuard)
  detail(@ActiveTenant() tenantId: string, @Param('caseId') caseId: string) { return this.cases.detail(tenantId, caseId) }

  @Post('cases/:caseId/transition') @HttpCode(200) @RequireDepartmentPermission('case.manage') @UseGuards(SupplyPermissionGuard)
  transition(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('caseId') caseId: string, @Body() body: CaseTransition) { return this.cases.transition(tenantId, identity.user.id, caseId, body ?? ({} as CaseTransition)) }

  @Post('cases/:caseId/assign') @HttpCode(200) @RequireDepartmentPermission('case.manage') @UseGuards(SupplyPermissionGuard)
  assign(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('caseId') caseId: string, @Body() body: CaseAssign) { return this.cases.assign(tenantId, identity.user.id, caseId, body ?? ({} as CaseAssign)) }

  @Post('cases/:caseId/notes') @RequireDepartmentPermission('case.manage') @UseGuards(SupplyPermissionGuard)
  addNote(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('caseId') caseId: string, @Body() body: CaseNoteCreate) { return this.cases.addNote(tenantId, identity.user.id, caseId, body ?? ({} as CaseNoteCreate)) }
}

