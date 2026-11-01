// B2B Distribution API v1: partner authentication (ADR 0075, amendment 4).
//
// A partner authenticates with one of:
//   Authorization: ApiKey fbk_<keyId>_<secret>      a long-lived API key
//   Authorization: Bearer fbt_<token>               an OAuth2 access token (15 minutes) from POST routes.distribution.oauthToken
// Never with a session cookie. The tenant and agency come from the credential only; no request field can choose them (CLAUDE.md invariant 1).

/** Scopes as they appear on the wire (OAuth `scope`, space-separated). */
export const DISTRIBUTION_API_SCOPES = ['search', 'checkrate', 'book', 'cancel', 'bookings:read'] as const
export type DistributionWireScope = (typeof DISTRIBUTION_API_SCOPES)[number]

/** Lifetime of an issued access token, in seconds. */
export const DISTRIBUTION_TOKEN_TTL_SECONDS = 900

/**
 * POST routes.distribution.oauthToken, `application/x-www-form-urlencoded` (or JSON), OAuth 2.0 client credentials (RFC 6749 section 4.4).
 * Client authentication: HTTP Basic `client_id:client_secret` (preferred) or these body fields; never both.
 */
export interface DistributionTokenRequest {
  grant_type: 'client_credentials'
  /** Space-separated subset of the client's scopes. Omitted: all of them. */
  scope?: string
  client_id?: string
  client_secret?: string
}

/**
 * The token endpoint answers in the OAuth 2.0 wire format (RFC 6749 sections 5.1 and 5.2), NOT the standard `ApiEnvelope`, so off-the-shelf OAuth
 * clients work unchanged. Responses carry `Cache-Control: no-store`.
 */
export interface DistributionTokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  /** Space-separated scopes actually granted. */
  scope: string
}

export interface DistributionTokenError {
  /** 400 invalid_request | unsupported_grant_type | invalid_scope; 401 invalid_client; 503 temporarily_unavailable. */
  error: 'invalid_request' | 'invalid_client' | 'unsupported_grant_type' | 'invalid_scope' | 'temporarily_unavailable'
  error_description?: string
}

/** GET routes.distribution.me, inside the standard `ApiEnvelope`: who the presented credential is. */
export interface DistributionMeResponse {
  clientId: string
  agencyId: string
  authenticatedWith: 'api_key' | 'access_token'
  scopes: DistributionWireScope[]
  /** Requests per minute per scope class. Enforcement arrives with the partner quotas (ADR 0075 step 3). */
  limits: { searchPerMinute: number; checkRatePerMinute: number; bookPerMinute: number }
}
