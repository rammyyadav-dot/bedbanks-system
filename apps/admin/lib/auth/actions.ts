'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { authApi, ApiResponseError } from '../api/auth-client';

const COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? 'fbeds_session';

export interface LoginActionState {
  error: string | null;
}

/**
 * Server Action — handles login form submission.
 *
 * Credentials go server → API and nowhere else. The session cookie is
 * set by the API's Set-Cookie response header and forwarded through by
 * Next.js; the browser never touches the raw token value.
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
    await authApi.login(email, password);
  } catch (error) {
    if (error instanceof ApiResponseError) {
      if (error.status === 401) return { error: 'Invalid email or password.' };
      if (error.status === 422 || error.status === 400) return { error: 'Please check your email address.' };
      return { error: 'Sign in is unavailable right now. Please try again.' };
    }
    return { error: 'Unable to reach the authentication service. Please try again.' };
  }

  redirect('/dashboard');
}

/**
 * Server Action — logs out the current session.
 *
 * Calls the API to revoke the session (so it's immediately dead in the
 * database, not just cleared from the browser) then redirects to login.
 */
export async function logoutAction(): Promise<void> {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get(COOKIE_NAME);
    if (sessionCookie) {
      await authApi.logout(`${COOKIE_NAME}=${sessionCookie.value}`);
    }
  } catch {
    // Best-effort — even if the API call fails, clear the cookie and
    // redirect. The session will expire naturally via the DB TTL.
  }

  redirect('/login');
}
