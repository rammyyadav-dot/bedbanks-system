import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { ApprovalsModule } from '../approvals/approvals.module'
import { HotelPublicationService } from './hotel-publication.service'
import { HotelSetupController } from './hotel-setup.controller'
import { HotelSetupService } from './hotel-setup.service'
import { HotelRoomsController } from './hotel-rooms.controller'
import { HotelRoomsService } from './hotel-rooms.service'
import { HotelAmenitiesService } from './hotel-amenities.service'
import { HotelQuickUpdateController } from './hotel-quick-update.controller'
import { HotelQuickUpdateService } from './hotel-quick-update.service'

/** Hotel Setup (ADR 0021). */
@Module({ imports: [AuthModule, ApprovalsModule], controllers: [HotelSetupController, HotelRoomsController, HotelQuickUpdateController], providers: [HotelSetupService, HotelPublicationService, HotelRoomsService, HotelAmenitiesService, HotelQuickUpdateService] })
export class HotelSetupModule {}
