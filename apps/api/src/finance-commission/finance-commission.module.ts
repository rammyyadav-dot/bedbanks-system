import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { CommissionPayoutController } from './commission-payout.controller'
import { CommissionPayoutService } from './commission-payout.service'

/** Dynamic, tier-based commission payouts to agencies (ADR 0098). */
@Module({ imports: [AuthModule], controllers: [CommissionPayoutController], providers: [CommissionPayoutService] })
export class FinanceCommissionModule {}
