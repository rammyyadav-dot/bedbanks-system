import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { TenantContextGuard } from '../agent/tenant-context.guard'
import { SupplierExtranetController } from './supplier-extranet.controller'
import { SupplierExtranetService } from './supplier-extranet.service'
import { SupplierBookingsService } from './supplier-bookings.service'
import { SupplierBookingAnswerService } from './supplier-booking-answer.service'
import { SupplierChangeSetsController } from './supplier-change-sets.controller'
import { SupplierChangeSetsService } from './supplier-change-sets.service'
import { BookingOpsDatabase } from '../booking-ops/booking-ops-database'
import { SupplierOrganizationGuard } from './supplier-organization.guard'

@Module({
  imports: [AuthModule],
  controllers: [SupplierExtranetController, SupplierChangeSetsController],
  providers: [SupplierExtranetService, SupplierBookingsService, SupplierBookingAnswerService, SupplierChangeSetsService, BookingOpsDatabase, SupplierOrganizationGuard, TenantContextGuard],
})
export class SupplierExtranetModule {}
