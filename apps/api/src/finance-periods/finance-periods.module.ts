import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { FinancePeriodController } from './finance-period.controller'
import { FinancePeriodService } from './finance-period.service'

/** Finance period close (ADR 0101). */
@Module({ imports: [AuthModule], controllers: [FinancePeriodController], providers: [FinancePeriodService] })
export class FinancePeriodsModule {}
