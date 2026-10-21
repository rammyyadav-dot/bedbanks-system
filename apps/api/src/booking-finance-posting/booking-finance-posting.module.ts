import { Module } from '@nestjs/common'
import { BookingFinancePostingDatabase } from './booking-finance-posting.database'
import { BookingFinancePostingService } from './booking-finance-posting.service'
import { BookingFinancePostingWorker } from './booking-finance-posting.worker'

/** The Finance consumer of BookingFinanceEvent (ADR 0076). Off unless its flags and its own database role are configured. */
@Module({
  providers: [BookingFinancePostingDatabase, BookingFinancePostingService, BookingFinancePostingWorker],
  exports: [BookingFinancePostingService],
})
export class BookingFinancePostingModule {}
