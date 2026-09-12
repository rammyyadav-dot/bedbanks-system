import type { Role } from '../types/admin';

const perms = (resource: string, actions: Role['permissions'][number]['actions']) => ({ id: `p_${resource}`, resource, actions });

export const roles: Role[] = [
  {
    id: 'r_platform_admin', name: 'Platform Admin', description: 'Full platform access across all tenants.', userCount: 3, status: 'active',
    permissions: [perms('Tenants', ['read', 'create', 'edit', 'delete']), perms('Users', ['read', 'create', 'edit', 'delete']), perms('Hotels', ['read', 'create', 'edit']), perms('Bookings', ['read']), perms('Finance', ['read', 'edit']), perms('Audit', ['read'])],
  },
  {
    id: 'r_tenant_admin', name: 'Tenant Admin', description: 'Full access scoped to a single tenant.', userCount: 6, status: 'active',
    permissions: [perms('Tenants', ['read']), perms('Users', ['read', 'create', 'edit']), perms('Hotels', ['read']), perms('Bookings', ['read']), perms('Finance', ['read']), perms('Audit', ['read'])],
  },
  {
    id: 'r_ops_agent', name: 'Operations Agent', description: 'Day-to-day booking and supply operations.', userCount: 14, status: 'active',
    permissions: [perms('Tenants', []), perms('Users', []), perms('Hotels', ['read', 'edit']), perms('Bookings', ['read']), perms('Finance', []), perms('Audit', [])],
  },
  {
    id: 'r_finance_viewer', name: 'Finance Viewer', description: 'Read-only visibility into wallets and ledger.', userCount: 5, status: 'active',
    permissions: [perms('Tenants', ['read']), perms('Users', []), perms('Hotels', []), perms('Bookings', ['read']), perms('Finance', ['read']), perms('Audit', ['read'])],
  },
];

export const permissionResources = ['Tenants', 'Users', 'Hotels', 'Bookings', 'Finance', 'Audit'];
