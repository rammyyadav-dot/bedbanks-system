// Routes the Agent portal calls (ADR 0075). Kept in their own module so `@bedbanks/contracts/agent` carries no other audience's paths;
// `routes` in routes.ts composes them.
export const authRoutes = {
  login: '/auth/login', logout: '/auth/logout', me: '/auth/me',
  /** Public: which optional sign-in features this deployment really supports (ADR 0091). */
  capabilities: '/auth/capabilities',
  passwordResetRequest: '/auth/password-reset/request',
  passwordResetConfirm: '/auth/password-reset/confirm',
} as const

export const agentRoutes = {
  context: '/agent/context', destinations: '/agent/destinations', searchFacets: '/agent/search-facets', hotelImage: '/agent/hotels/:hotelId/images/:imageId/content', searchStatus: '/agent/search/status', search: '/agent/search', smartSearchParse: '/agent/search/parse', recheck: '/agent/rates/recheck', holdOffer: '/agent/offers/:offerId/hold', releaseHold: '/agent/holds/:holdId', prebook: '/agent/prebook',
  bookings: '/agent/bookings', booking: '/agent/bookings/:id', reconcileStaleBookings: '/agent/bookings/reconcile-stale', cancelBooking: '/agent/bookings/:id', cancellationQuote: '/agent/bookings/:id/cancellation-quote', bookingDocument: '/agent/bookings/:id/documents/:type', bookingDocumentHtml: '/agent/bookings/:id/documents/:type/html', financeSummary: '/agent/finance/summary', fundingReceipts: '/agent/funding/receipts', audit: '/agent/audit',
} as const

/** Served by the Agent portal itself, outside the /api/v1 proxy. Paths are absolute. */
export const agentLocalRoutes = {
  /** GET: validate and normalise hotel search filter query parameters. 200 with the filters, or 400 with an ErrorEnvelope. */
  searchFilters: '/api/search-filters',
} as const
