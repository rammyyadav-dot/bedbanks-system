import { Module } from '@nestjs/common'
import { ApprovalsModule } from '../approvals/approvals.module'
import { TenantControlService } from './tenant-control.service'
import { AuthModule } from '../auth/auth.module'
import { PlatformAdminController } from './platform-admin.controller'
import { PlatformAdminService } from './platform-admin.service'
import { PlatformAccessService } from './platform-access.service'
import { PlatformAccessController } from './platform-access.controller'
import { PlatformRbacGuard } from './platform-rbac.guard'

@Module({
  imports: [AuthModule, ApprovalsModule],
  controllers: [PlatformAdminController, PlatformAccessController],
  providers: [TenantControlService, PlatformAdminService, PlatformAccessService, PlatformRbacGuard],
})
export class PlatformAdminModule {}
