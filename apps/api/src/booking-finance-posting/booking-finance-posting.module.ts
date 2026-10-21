import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { BookingFinancePostingBacklogService } from './booking-finance-posting-backlog.service'
import { BookingFinancePostingController } from './booking-finance-posting.controller'
import { BookingFinancePostingDatabase } from './booking-finance-posting.database'
import { BookingFinancePostingService } from './booking-finance-posting.service'
import { BookingFinancePostingWorker } from './booking-finance-posting.worker'

/** The Finance consumer of BookingFinanceEvent and its read-only backlog (ADR 0076). Posting is off unless its flags and its own database role are configured. */
@Module({
  imports: [AuthModule],
  controllers: [BookingFinancePostingController],
  providers: [BookingFinancePostingDatabase, BookingFinancePostingService, BookingFinancePostingBacklogService, BookingFinancePostingWorker],
  exports: [BookingFinancePostingService],
})
export class BookingFinancePostingModule {}
