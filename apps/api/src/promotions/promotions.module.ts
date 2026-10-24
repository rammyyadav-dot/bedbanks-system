import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { ApprovalsModule } from '../approvals/approvals.module'
import { HotelDealController } from './hotel-deal.controller'
import { HotelDealService } from './hotel-deal.service'

/** Hotel deals and promotions (ADR 0089): authoring, maker-checker approval, lifecycle and the read-only simulator. Pricing stays in the shared evaluator. */
@Module({ imports: [AuthModule, ApprovalsModule], controllers: [HotelDealController], providers: [HotelDealService] })
export class PromotionsModule {}
