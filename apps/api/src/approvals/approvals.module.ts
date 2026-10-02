import { Module } from '@nestjs/common'
import { AgentAuditService } from '../agent/audit.service'
import { ApprovalService } from './approval.service'

/** Foundation only (ADR 0016): exported for the departments that will adopt maker-checker; no controller, no route. */
@Module({ providers: [ApprovalService, AgentAuditService], exports: [ApprovalService] })
export class ApprovalsModule {}
