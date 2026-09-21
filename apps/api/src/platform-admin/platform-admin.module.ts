import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { PlatformAdminController } from './platform-admin.controller'
import { PlatformAdminService } from './platform-admin.service'
import { PlatformAccessService } from './platform-access.service'
import { PlatformAccessController } from './platform-access.controller'
import { PlatformRbacGuard } from './platform-rbac.guard'

@Module({
  imports: [AuthModule],
  controllers: [PlatformAdminController, PlatformAccessController],
  providers: [PlatformAdminService, PlatformAccessService, PlatformRbacGuard],
})
export class PlatformAdminModule {}
