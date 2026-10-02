import { Module } from '@nestjs/common'
import { AgentModule } from '../agent/agent.module'
import { AuthModule } from '../auth/auth.module'
import { OperationsController } from './operations.controller'
import { OperationsHotelsService } from './operations-hotels.service'
import { OperationsSupplyService } from './operations-supply.service'
import { OperationsTransactionsService } from './operations-transactions.service'

@Module({
  imports: [AuthModule, AgentModule],
  controllers: [OperationsController],
  providers: [OperationsSupplyService, OperationsTransactionsService, OperationsHotelsService],
})
export class AdminOperationsModule {}
