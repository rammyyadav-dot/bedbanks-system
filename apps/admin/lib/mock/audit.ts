import type { AuditEvent } from '../types/admin';

export const auditEvents: AuditEvent[] = [
  { id: 'ae_1', timestamp: '2026-09-09T08:12:03Z', actor: 'Jordan Davis', tenant: 'Atlas Getaways', action: 'tenant.viewed', resource: 'Tenant', resourceId: 't_travel', requestId: 'req_88a2', status: 'success', metadata: { ip: '203.0.113.4' } },
  { id: 'ae_2', timestamp: '2026-09-09T07:58:11Z', actor: 'System', tenant: '—', action: 'policy.evaluated', resource: 'AccessPolicy', resourceId: 'pol_442', requestId: 'req_88a1', status: 'success', metadata: {} },
  { id: 'ae_3', timestamp: '2026-09-09T07:41:55Z', actor: 'Maya Chen', tenant: 'Travel Republic', action: 'membership.role_updated', resource: 'Membership', resourceId: 'mem_209', requestId: 'req_8891', status: 'success', metadata: { from: 'Operations Agent', to: 'Tenant Admin' } },
  { id: 'ae_4', timestamp: '2026-09-08T21:03:47Z', actor: 'Omar Khan', tenant: 'Holiday Lines', action: 'tenant.suspend_attempt', resource: 'Tenant', resourceId: 't_holiday', requestId: 'req_8712', status: 'failed', metadata: { reason: 'insufficient_permissions' } },
  { id: 'ae_5', timestamp: '2026-09-08T19:15:02Z', actor: 'Priya Nair', tenant: 'Global Holidays', action: 'wallet.viewed', resource: 'Wallet', resourceId: 't_global', requestId: 'req_8655', status: 'success', metadata: {} },
  { id: 'ae_6', timestamp: '2026-09-08T14:02:18Z', actor: 'System', tenant: '—', action: 'supplier.sync_failed', resource: 'Supplier', resourceId: 'sup_regional_dmc', requestId: 'req_8602', status: 'failed', metadata: { error: 'timeout' } },
];
