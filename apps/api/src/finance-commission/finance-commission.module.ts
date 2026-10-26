import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { BookingFinancePostingModule } from '../booking-finance-posting/booking-finance-posting.module'
import { CommissionPayoutController } from './commission-payout.controller'
import { CommissionPayoutService } from './commission-payout.service'
import { CommissionPayoutScheduler } from './commission-payout-scheduler.service'

/** Dynamic, tier-based commission payouts to agencies (ADR 0098), plus the scheduler that proposes them automatically. */
@Module({ imports: [AuthModule, BookingFinancePostingModule], controllers: [CommissionPayoutController], providers: [CommissionPayoutService, CommissionPayoutScheduler] })
export class FinanceCommissionModule {}
