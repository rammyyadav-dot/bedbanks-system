export const routes = {
  auth: { login: '/auth/login', logout: '/auth/logout', me: '/auth/me' },
  agent: {
    context: '/agent/context', searchStatus: '/agent/search/status', search: '/agent/search', recheck: '/agent/rates/recheck', prebook: '/agent/prebook',
    bookings: '/agent/bookings', cancelBooking: '/agent/bookings/:id', financeSummary: '/agent/finance/summary', audit: '/agent/audit',
  },
  admin: { dashboard: '/admin/dashboard' },
  platform: {
    tenants: '/platform/tenants', tenantSummary: '/platform/tenants/:tenantId/summary',
    permissions: '/platform/access/permissions', roles: '/platform/access/roles', assignments: '/platform/access/assignments', revokeAssignment: '/platform/access/assignments/:userId/:roleId',
  },
  supplier: {},
  partner: {},
  health: { status: '/health' },
} as const;

export type RoutePath = (typeof routes.auth)[keyof typeof routes.auth] | (typeof routes.agent)[keyof typeof routes.agent] | (typeof routes.admin)[keyof typeof routes.admin] | (typeof routes.platform)[keyof typeof routes.platform] | (typeof routes.health)[keyof typeof routes.health];
