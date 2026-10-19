import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { AgentAuditService } from '../agent/audit.service'
import { ApprovalsModule } from '../approvals/approvals.module'
import { CommercialController } from './commercial.controller'
import { CommercialMarkupService } from './commercial-markup.service'
import { CommercialFxController } from './commercial-fx.controller'
import { CommercialFxService } from './commercial-fx.service'

@Module({ imports: [AuthModule, ApprovalsModule], controllers: [CommercialController, CommercialFxController], providers: [CommercialMarkupService, CommercialFxService, AgentAuditService] })
export class CommercialModule {}
