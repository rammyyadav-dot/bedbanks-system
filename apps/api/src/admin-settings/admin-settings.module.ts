import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { AdminRbacGuard } from '../auth/admin-rbac.guard'
import { AdminSettingsController } from './admin-settings.controller'
import { AdminSettingsService } from './admin-settings.service'

@Module({
  imports: [AuthModule],
  controllers: [AdminSettingsController],
  providers: [AdminSettingsService, AdminRbacGuard],
})
export class AdminSettingsModule {}
