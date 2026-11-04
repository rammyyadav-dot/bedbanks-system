/**
 * Admin routes that are not live department modules (ADR 0112).
 * A dashboard page is a live module, a child of one, a redirect, or an entry here.
 * Unavailable routes render FeatureUnavailable and do not call the API.
 */

export const unavailableAdminRoutes = [
  '/finance',
  '/finance/payments',
  '/distribution',
  '/pricing',
  '/reports',
  '/notifications',
  '/users',
  '/users/[id]',
] as const

export const redirectAdminRoutes = [
  '/inventory',
  '/operations/hotels',
] as const

/**
 * Release scope for live finance screens. Read-only views show ledger figures.
 * Mutation screens are implemented and are not production-certified: a button is not approval to move money.
 */
export const financeReleaseScope = {
  readOnly: [
    '/finance/wallets',
    '/finance/receivables',
    '/finance/payables',
    '/finance/refunds',
    '/finance/credit-notes',
    '/finance/booking-postings',
    '/finance/booking-revenue',
  ],
  uncertifiedMutation: [
    '/finance/ledger',
    '/finance/funding',
    '/finance/ledger-adjustments',
    '/finance/periods',
    '/finance/chart',
    '/finance/reconciliation',
    '/finance/supplier-settlements',
  ],
} as const
