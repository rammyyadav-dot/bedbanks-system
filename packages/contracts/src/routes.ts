export const routes = {
  auth: { login: '/auth/login', logout: '/auth/logout', me: '/auth/me' },
  agent: {
    context: '/agent/context', searchStatus: '/agent/search/status', search: '/agent/search', recheck: '/agent/rates/recheck', holdOffer: '/agent/offers/:offerId/hold', prebook: '/agent/prebook',
    bookings: '/agent/bookings', cancelBooking: '/agent/bookings/:id', financeSummary: '/agent/finance/summary', audit: '/agent/audit',
  },
  admin: { dashboard: '/admin/dashboard' },
  platform: {
    tenants: '/platform/tenants', tenantSummary: '/platform/tenants/:tenantId/summary',
    permissions: '/platform/access/permissions', roles: '/platform/access/roles', assignments: '/platform/access/assignments', revokeAssignment: '/platform/access/assignments/:userId/:roleId',
  },
  supplier: {},
  platformAccess: {
    permissions: '/platform/access/permissions', roles: '/platform/access/roles', role: '/platform/access/roles/:roleId', rolePermissions: '/platform/access/roles/:roleId/permissions', assignments: '/platform/access/assignments', assignment: '/platform/access/assignments/:userId/:roleId',
  },
  supply: {
    hotelMappings: '/supply/mappings/hotels', hotelMapping: '/supply/mappings/hotels/:mappingId', roomMappings: '/supply/mappings/hotels/:mappingId/rooms', roomMapping: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId',
    mappingOptions: '/supply/mappings/options', mappingRoomOptions: '/supply/mappings/options/rooms/:mappingId',
    hotelMappingApprove: '/supply/mappings/hotels/:mappingId/approve', hotelMappingReject: '/supply/mappings/hotels/:mappingId/reject', hotelMappingReopen: '/supply/mappings/hotels/:mappingId/reopen',
    roomMappingApprove: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/approve', roomMappingReject: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/reject', roomMappingReopen: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/reopen',
    hotels: '/supply/hotels', hotel: '/supply/hotels/:hotelId', hotelRooms: '/supply/hotels/:hotelId/rooms', hotelRoom: '/supply/hotels/:hotelId/rooms/:roomId', roomTypes: '/supply/room-types', boardBases: '/supply/board-bases',
    contracts: '/supply/contracts', ratePlans: '/supply/rate-plans', dailyRates: '/supply/daily-rates',
    availability: '/supply/availability', sellability: '/supply/sellability',
  },
  partner: {},
  health: { status: '/health' },
} as const;

export type RoutePath = (typeof routes.auth)[keyof typeof routes.auth] | (typeof routes.agent)[keyof typeof routes.agent] | (typeof routes.admin)[keyof typeof routes.admin] | (typeof routes.platform)[keyof typeof routes.platform] | (typeof routes.platformAccess)[keyof typeof routes.platformAccess] | (typeof routes.supply)[keyof typeof routes.supply] | (typeof routes.health)[keyof typeof routes.health];
