export const routes = {
  auth: { login: '/auth/login', logout: '/auth/logout', me: '/auth/me' },
  agent: {
    context: '/agent/context', searchStatus: '/agent/search/status', search: '/agent/search', recheck: '/agent/rates/recheck', prebook: '/agent/prebook',
    bookings: '/agent/bookings', cancelBooking: '/agent/bookings/:id', financeSummary: '/agent/finance/summary', audit: '/agent/audit',
  },
  admin: { dashboard: '/admin/dashboard' },
  supplier: {},
  partner: {},
  health: { status: '/health' },
} as const;

export type RoutePath = (typeof routes.auth)[keyof typeof routes.auth] | (typeof routes.agent)[keyof typeof routes.agent] | (typeof routes.admin)[keyof typeof routes.admin] | (typeof routes.health)[keyof typeof routes.health];
