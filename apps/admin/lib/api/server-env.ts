import 'server-only';

function required(name: 'API_INTERNAL_URL' | 'AUTH_API_ORIGIN', developmentDefault: string): string {
  const value = process.env[name]?.trim();
  if (value) return value.replace(/\/+$/, '');
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`${name} must be configured for the Admin console`);
  }
  return developmentDefault;
}

/** Evaluated per call so builds without runtime secrets still succeed. */
export function apiInternalUrl(): string {
  return required('API_INTERNAL_URL', 'http://localhost:3002/api/v1');
}

/** Must equal the API's ADMIN_ORIGIN; the API rejects mutating requests from any other origin. */
export function apiTrustedOrigin(): string {
  return required('AUTH_API_ORIGIN', 'http://localhost:3001');
}

export const SESSION_COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? 'fbeds_session';
