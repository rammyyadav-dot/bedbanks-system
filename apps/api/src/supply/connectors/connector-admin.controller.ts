import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { SessionAuthGuard } from '../../auth/guards/session-auth.guard'
import { OriginGuard } from '../../auth/guards/origin.guard'
import { TenantContextGuard, ACTIVE_TENANT_REQUEST_KEY } from '../../agent/tenant-context.guard'
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface'
import { ConnectorAdminService } from './connector-admin.service'

/** Tenant and user come from the authenticated request only; the service enforces supply.suppliers.read / .manage and audits every write. */
@Controller('supply/connectors')
@UseGuards(SessionAuthGuard, OriginGuard, TenantContextGuard)
export class ConnectorAdminController {
  constructor(private readonly connectors: ConnectorAdminService) {}
  private context(req: Request) {
    return { userId: (req as unknown as { user: AuthenticatedUser }).user.user.id, tenantId: (req as unknown as Record<string, string>)[ACTIVE_TENANT_REQUEST_KEY], requestId: (req as unknown as { requestId?: string }).requestId }
  }
  @Get() list(@Req() req: Request) { const c = this.context(req); return this.connectors.list(c.tenantId, c.userId, c.requestId) }
  @Post() create(@Req() req: Request, @Body() body: unknown, @Headers('idempotency-key') key?: string) { const c = this.context(req); return this.connectors.create(c.tenantId, c.userId, body, key, c.requestId) }
  @Get(':connectorId') get(@Req() req: Request, @Param('connectorId') id: string) { const c = this.context(req); return this.connectors.get(c.tenantId, c.userId, id, c.requestId) }
  @Get(':connectorId/readiness') readiness(@Req() req: Request, @Param('connectorId') id: string) { const c = this.context(req); return this.connectors.get(c.tenantId, c.userId, id, c.requestId).then((v) => v.readiness) }
  @Patch(':connectorId') update(@Req() req: Request, @Param('connectorId') id: string, @Body() body: unknown) { const c = this.context(req); return this.connectors.update(c.tenantId, c.userId, id, body, c.requestId) }
  @Put(':connectorId/credentials/:purpose') setCredential(@Req() req: Request, @Param('connectorId') id: string, @Param('purpose') purpose: string, @Body() body: unknown) { const c = this.context(req); return this.connectors.setCredential(c.tenantId, c.userId, id, purpose, body, c.requestId) }
  @Delete(':connectorId/credentials/:purpose') removeCredential(@Req() req: Request, @Param('connectorId') id: string, @Param('purpose') purpose: string) { const c = this.context(req); return this.connectors.removeCredential(c.tenantId, c.userId, id, purpose, c.requestId) }
}
