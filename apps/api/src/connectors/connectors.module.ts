import { Module } from '@nestjs/common'
import { AgentAuditService } from '../agent/audit.service'
import { ApprovalsModule } from '../approvals/approvals.module'
import { AuthModule } from '../auth/auth.module'
import { ConnectorAdminController } from './connector-admin.controller'
import { ConnectorAdminService } from './connector-admin.service'
import { ConnectorSecretResolver } from './connector-secret-resolver'

/**
 * Connector administration and secret resolution (ADR 0085). Secret resolution is off unless `CONNECTOR_SECRETS_PREFIX` is set; with it unset the admin API refuses to store a credential
 * reference and nothing resolves. No supplier is wired to the resolver here: a provider profile adopts it through `asTransportResolver`.
 */
@Module({ imports: [AuthModule, ApprovalsModule], controllers: [ConnectorAdminController], providers: [ConnectorAdminService, ConnectorSecretResolver, AgentAuditService], exports: [ConnectorSecretResolver] })
export class ConnectorsModule {}
