import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { PlatformAdminController } from './platform-admin.controller'
import { PlatformAdminService } from './platform-admin.service'
import { PlatformRbacGuard } from './platform-rbac.guard'

@Module({
  imports: [AuthModule],
  controllers: [PlatformAdminController],
  providers: [PlatformAdminService, PlatformRbacGuard],
})
export class PlatformAdminModule {}
