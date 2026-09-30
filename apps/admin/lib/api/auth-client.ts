import 'server-only';
import { routes } from '@bedbanks/contracts';
import { ApiResponseError, type ApiError } from './errors';
import { apiInternalUrl, apiTrustedOrigin } from './server-env';
export { ApiResponseError } from './errors';

async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<{ data: T; response: Response }> {
  const res = await fetch(`${apiInternalUrl()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Origin: apiTrustedOrigin(), ...(init?.headers ?? {}) },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });

  const body = await res.json();

  if (!res.ok) {
    const err = body as { success: false; error: ApiError };
    throw new ApiResponseError(
      err.error?.code ?? 'UNKNOWN',
      err.error?.message ?? 'Request failed',
      res.status,
    );
  }

  if (body.success !== true) throw new Error('Invalid authentication response');
  return { data: (body as { success: true; data: T }).data, response: res };
}

export interface SafeUser {
  id: string;
  email: string;
  name: string | null;
  status: 'ACTIVE' | 'SUSPENDED';
}

export interface MembershipSummary {
  tenantId: string;
  tenantName: string;
  role: string;
}

export interface AuthenticatedUser {
  user: SafeUser;
  memberships: MembershipSummary[];
}

export const authApi = {
  async login(email: string, password: string) {
    const { response } = await apiFetch<AuthenticatedUser>(routes.auth.login, {
      method: 'POST', body: JSON.stringify({ email, password }),
    });
    // This header is consumed only by the Server Action, never returned to a client.
    return response.headers.getSetCookie();
  },
  async me(cookieHeader: string) {
    return (await apiFetch<AuthenticatedUser>(routes.auth.me, { headers: { Cookie: cookieHeader } })).data;
  },
  async logout(cookieHeader: string) {
    return (await apiFetch<{ loggedOut: boolean }>(routes.auth.logout, {
      method: 'POST', headers: { Cookie: cookieHeader },
    })).data;
  },
};
