'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { parseSessionCookie } from './session-cookie';
import { authApi, ApiResponseError } from '../api/auth-client';

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
  redirect('/login');
}
