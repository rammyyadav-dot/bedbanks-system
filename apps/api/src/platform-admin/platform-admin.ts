import { SetMetadata } from '@nestjs/common'

export const PLATFORM_PERMISSION_KEY = 'platform_permission'
export const RequirePlatformPermission = (permission: string) => SetMetadata(PLATFORM_PERMISSION_KEY, permission)

export interface PlatformTenantContext {
  operatorUserId: string
  targetTenantId: string
  permission: string
  requestId?: string
}
