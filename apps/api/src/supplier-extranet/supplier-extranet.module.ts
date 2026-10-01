import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { TenantContextGuard } from '../agent/tenant-context.guard'
import { SupplierExtranetController } from './supplier-extranet.controller'
import { SupplierExtranetService } from './supplier-extranet.service'
import { SupplierOrganizationGuard } from './supplier-organization.guard'

@Module({
  imports: [AuthModule],
  controllers: [SupplierExtranetController],
  providers: [SupplierExtranetService, SupplierOrganizationGuard, TenantContextGuard],
})
export class SupplierExtranetModule {}
