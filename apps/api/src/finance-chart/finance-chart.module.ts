import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { ChartController } from './chart.controller'
import { ChartService } from './chart.service'

/** General-ledger chart of accounts and journal (ADR 0102). */
@Module({ imports: [AuthModule], controllers: [ChartController], providers: [ChartService] })
export class FinanceChartModule {}
