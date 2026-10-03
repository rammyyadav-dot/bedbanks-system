import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { HotelSetupController } from './hotel-setup.controller'
import { HotelSetupService } from './hotel-setup.service'
import { HotelRoomsController } from './hotel-rooms.controller'
import { HotelRoomsService } from './hotel-rooms.service'
import { HotelAmenitiesService } from './hotel-amenities.service'

/** Hotel Setup (ADR 0021). */
@Module({ imports: [AuthModule], controllers: [HotelSetupController, HotelRoomsController], providers: [HotelSetupService, HotelRoomsService, HotelAmenitiesService] })
export class HotelSetupModule {}
