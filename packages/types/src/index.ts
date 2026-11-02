/**
 * Shared wire types for Admin, Agent and the API.
 *
 * Money is integer minor units plus an ISO-4217 code (CLAUDE.md invariant 3).
 * This package must never export a float `amount` field.
 */

export type CurrencyCode = string

export interface Money {
  amountMinor: number
  currency: CurrencyCode
}

export type LifecycleStatus = 'ACTIVE' | 'SUSPENDED'

export interface Pagination {
  page: number
  pageSize: number
  total: number
}

export interface SuccessEnvelope<T> {
  success: true
  data: T
}

export interface ErrorEnvelope {
  success: false
  error: { code: string; message: string; details: unknown[] }
  meta: { timestamp: string; path: string; requestId: string }
}

export type ApiEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope

export interface SafeUser {
  id: string
  email: string
  name: string | null
  status: LifecycleStatus
}

export interface MembershipSummary {
  tenantId: string
  tenantName: string
  role: string
}

export interface AuthenticatedUser {
  user: SafeUser
  memberships: MembershipSummary[]
}

export interface LoginRequest {
  email: string
  password: string
  rememberMe?: boolean
}

export interface PasswordResetRequest {
  email: string
}

export interface PasswordResetConfirm {
  token: string
  newPassword: string
}

/**
 * Canonical NestJS routes the portals call (global prefix `/api/v1`).
 * Search, hotels and bookings live under `/agent/*` and `/admin/*` — there is no
 * parallel `/hotels`, `/search` or `/bookings` resource (ADR 0075).
 */
export const domainRoutes = {
  auth: {
    login: '/auth/login',
    logout: '/auth/logout',
    me: '/auth/me',
    capabilities: '/auth/capabilities',
    passwordResetRequest: '/auth/password-reset/request',
    passwordResetConfirm: '/auth/password-reset/confirm',
  },
  search: '/agent/search',
  hotels: '/agent/hotels/:hotelId/images/:imageId/content',
  bookings: '/agent/bookings',
  health: '/health',
} as const
