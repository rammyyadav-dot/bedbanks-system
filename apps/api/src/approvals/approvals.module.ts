import { Module } from '@nestjs/common'
import { AgentAuditService } from '../agent/audit.service'
import { ApprovalService } from './approval.service'
import { DualApprovalGuard, StepUpGuard } from './dual-approval.guard'
import { StepUpService } from './step-up.service'

/**
 * Maker-checker building blocks (ADR 0016, ADR 0095): the approval state machine, password step-up for checkers, and the two guards that
 * keep a route from being reached without them. Exported for the departments that adopt maker-checker; the module has no controller or route.
 */
@Module({
  providers: [ApprovalService, AgentAuditService, StepUpService, StepUpGuard, DualApprovalGuard],
  exports: [ApprovalService, AgentAuditService, StepUpService, StepUpGuard, DualApprovalGuard],
})
export class ApprovalsModule {}
