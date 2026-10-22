'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { parseSessionCookie } from './session-cookie';
import { authApi, ApiResponseError } from '../api/auth-client';
import { ACTIVE_TENANT_COOKIE } from './active-tenant';
import { getSession } from './session';
import { safePostLoginPath } from './post-login-path';

const COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? 'fbeds_session';

export interface LoginActionState {
  error: string | null;
}

/**
 * Server Action — handles login form submission.
 *
 * Credentials go server → API and nowhere else. The API Set-Cookie header is explicitly copied to the Admin host
 * cookie store. Only the browser cookie mechanism receives the raw token.
 */
export async function loginAction(
  _prev: LoginActionState,
  formData: FormData,
): Promise<LoginActionState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  if (!email || !password) {
    return { error: 'Email and password are required.' };
  }

  try {
    const headers = await authApi.login(email, password);
    const cookie = parseSessionCookie(headers, COOKIE_NAME);
    const cookieStore = await cookies();
    cookieStore.set(COOKIE_NAME, cookie.value, cookie.options);
    // A new sign-in never inherits a tenant selection made by an earlier session in this browser.
    cookieStore.delete(ACTIVE_TENANT_COOKIE);
  } catch (error) {
    if (error instanceof ApiResponseError) {
      if (error.status === 401) return { error: 'Invalid email or password.' };
      if (error.status === 422 || error.status === 400) return { error: 'Please check your email address.' };
      return { error: 'Sign in is unavailable right now. Please try again.' };
    }
    return { error: 'Unable to reach the authentication service. Please try again.' };
  }

  // `from` is client-supplied (hidden field fed by the proxy's ?from=), so it is re-validated here, never trusted.
  redirect(safePostLoginPath(formData.get('from')));
}

/**
 * Server Action — logs out the current session.
 *
 * Calls the API to revoke the session (so it's immediately dead in the
 * database, not just cleared from the browser) then redirects to login.
 */
export async function logoutAction(): Promise<void> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(COOKIE_NAME);
  if (sessionCookie) {
    try {
      await authApi.logout(`${COOKIE_NAME}=${sessionCookie.value}`);
    } catch {
      // Keep the cookie so the user can retry revocation; never claim success.
      throw new Error('Sign out failed. Please try again.');
    }
  }
  cookieStore.set(COOKIE_NAME, '', {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0,
  });
  cookieStore.delete(ACTIVE_TENANT_COOKIE);
  redirect('/login');
}

export interface SwitchTenantResult {
  error: string;
}

/**
 * Server Action — selects the active tenant for this browser.
 *
 * The requested id is only accepted when it is one of the memberships the API returns for the current session
 * (fresh /auth/me, never client-supplied membership data). The selection is an httpOnly cookie that the layout
 * re-validates on every render; the API still re-checks membership, tenant status and RLS on every request.
 */
export async function switchTenantAction(tenantId: string): Promise<SwitchTenantResult> {
  let identity;
  try {
    identity = await getSession();
  } catch {
    return { error: 'Your session could not be verified. Please try again.' };
  }
  if (!identity) redirect('/login');
  if (typeof tenantId !== 'string' || !identity.memberships.some((membership) => membership.tenantId === tenantId)) {
    return { error: 'That tenant is not available to your account.' };
  }
  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_TENANT_COOKIE, tenantId, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
  // Land on a tenant-neutral page: a record opened under the previous tenant does not exist in the new one.
  redirect('/dashboard');
}
