import 'server-only';
import { routes } from '@bedbanks/contracts';
import { serverApiRequest } from '../api/server-request';

export async function getRoles() { return serverApiRequest(routes.platformAccess.roles); }
export async function getPlatformPermissions() { return serverApiRequest(routes.platformAccess.permissions); }
export async function getPlatformAssignments() { return serverApiRequest(routes.platformAccess.assignments); }
export async function getPlatformTenants() { return serverApiRequest(routes.platform.tenants); }
export async function getPlatformTenantSummary(tenantId: string) { return serverApiRequest(routes.platform.tenantSummary.replace(':tenantId', encodeURIComponent(tenantId))); }
