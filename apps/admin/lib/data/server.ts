import 'server-only';
import { routes, type PlatformTenantSummaryView, type PlatformTenantView } from '@bedbanks/contracts';
import { serverApiRequest } from '../api/server-request';

export async function getPlatformTenants() { return serverApiRequest<PlatformTenantView[]>(routes.platform.tenants); }
export async function getPlatformTenantSummary(tenantId: string) {
  return serverApiRequest<PlatformTenantSummaryView>(routes.platform.tenantSummary.replace(':tenantId', encodeURIComponent(tenantId)));
}

export async function getRoles() { return serverApiRequest(routes.platformAccess.roles); }
export async function getPlatformPermissions() { return serverApiRequest(routes.platformAccess.permissions); }
export async function getPlatformAssignments() { return serverApiRequest(routes.platformAccess.assignments); }
