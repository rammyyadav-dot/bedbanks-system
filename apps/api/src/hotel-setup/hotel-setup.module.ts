import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { HotelSetupController } from './hotel-setup.controller'
import { HotelSetupService } from './hotel-setup.service'

/** Hotel Setup (ADR 0021). */
@Module({ imports: [AuthModule], controllers: [HotelSetupController], providers: [HotelSetupService] })
export class HotelSetupModule {}
