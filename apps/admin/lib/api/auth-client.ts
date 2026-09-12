/**
 * Thin server-side fetch wrapper for the FBEDS API.
 *
 * Only used from Server Components, Server Actions, and Route Handlers
 * — never imported in client components. Cookie forwarding (the session
 * cookie) is handled by Next.js automatically when `credentials:
 * 'include'` is set and the API is on the same host, or explicitly via
 * the `Cookie` header in Route Handlers where `next/headers` is
 * available.
 *
 * P0-D: endpoints used are login, me, logout only. As the backend
 * grows, add typed functions here rather than scattering raw fetch
 * calls across pages.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1';

export interface ApiError {
  code: string;
  message: string;
  details: unknown[];
}

export class ApiResponseError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiResponseError';
  }
}

async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    credentials: 'include',
    ...init,
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

  return (body as { success: true; data: T }).data;
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
  login(email: string, password: string, cookieHeader?: string) {
    return apiFetch<AuthenticatedUser>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      headers: cookieHeader ? { Cookie: cookieHeader } : {},
    });
  },

  me(cookieHeader: string) {
    return apiFetch<AuthenticatedUser>('/auth/me', {
      headers: { Cookie: cookieHeader },
    });
  },

  logout(cookieHeader: string) {
    return apiFetch<{ loggedOut: boolean }>('/auth/logout', {
      method: 'POST',
      headers: { Cookie: cookieHeader },
    });
  },
};
