import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { AgentAuditService } from '../agent/audit.service'
import { ApprovalsModule } from '../approvals/approvals.module'
import { CommercialController } from './commercial.controller'
import { CommercialMarkupService } from './commercial-markup.service'

@Module({ imports: [AuthModule, ApprovalsModule], controllers: [CommercialController], providers: [CommercialMarkupService, AgentAuditService] })
export class CommercialModule {}
