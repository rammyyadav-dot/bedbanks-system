import type { PlatformTenantStatus } from '@bedbanks/contracts'
import type { Status } from '@/lib/types/admin'

export function tenantStatus(status: PlatformTenantStatus): Status {
  return status === 'ACTIVE' ? 'active' : 'suspended'
}
