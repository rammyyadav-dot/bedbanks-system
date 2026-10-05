import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { ApprovalsModule } from '../approvals/approvals.module'
import { HotelPublicationService } from './hotel-publication.service'
import { HotelSetupController } from './hotel-setup.controller'
import { HotelSetupService } from './hotel-setup.service'
import { HotelRoomsController } from './hotel-rooms.controller'
import { HotelRoomsService } from './hotel-rooms.service'
import { HotelAmenitiesService } from './hotel-amenities.service'
import { HotelImagesController } from './hotel-images.controller'
import { HotelImagesService } from './hotel-images.service'
import { HotelQuickUpdateController } from './hotel-quick-update.controller'
import { HotelQuickUpdateService } from './hotel-quick-update.service'
import { InventoryAdminController } from '../inventory/inventory-admin.controller'
import { InventoryAdminService } from '../inventory/inventory-admin.service'
import { PoolCapacityController } from '../inventory/pool-capacity.controller'
import { PoolCapacityService } from '../inventory/pool-capacity.service'
import { PoolNightRequestService } from '../inventory/pool-night-request.service'

/** Hotel Setup (ADR 0021) and Inventory & Allotment administration (ADR 0030). */
@Module({ imports: [AuthModule, ApprovalsModule], controllers: [HotelSetupController, HotelRoomsController, HotelQuickUpdateController, HotelImagesController, InventoryAdminController, PoolCapacityController], providers: [InventoryAdminService, PoolCapacityService, PoolNightRequestService, HotelSetupService, HotelPublicationService, HotelRoomsService, HotelAmenitiesService, HotelQuickUpdateService, HotelImagesService] })
export class HotelSetupModule {}
