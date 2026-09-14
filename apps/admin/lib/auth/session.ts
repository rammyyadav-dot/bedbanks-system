import { cookies } from 'next/headers';
import { authApi, type AuthenticatedUser, ApiResponseError } from '../api/auth-client';

const COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? 'fbeds_session';

/**
 * Reads the session cookie from the incoming request and validates it
 * against the API. Returns the authenticated identity or null.
 *
 * Used in middleware (to protect routes) and in Server Components (to
 * get the current user for rendering). The cookie is forwarded to the
 * API by passing the raw Cookie header — the API validates the opaque
 * token there, so this layer never touches crypto directly.
 */
export async function getSession(): Promise<AuthenticatedUser | null> {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get(COOKIE_NAME);
    if (!sessionCookie) return null;

    // Forward the full Cookie header so the API receives the session
    // token in exactly the same shape as a browser request would send.
    const cookieHeader = `${COOKIE_NAME}=${sessionCookie.value}`;
    return await authApi.me(cookieHeader);
  } catch (error) {
    if (error instanceof ApiResponseError && (error.status === 401 || error.status === 403)) {
      return null;
    }
    // Surface unexpected errors (network failure, API down) rather than
    // silently treating them as "not logged in" — the difference matters
    // for debugging, even if the UI response is the same.
    console.error('[getSession] Unexpected error:', error);
    return null;
  }
}

/**
 * Like getSession, but throws a redirect-compatible error if there is
 * no valid session. Used in Server Components that should never render
 * for unauthenticated users — puts the redirect in one place rather
 * than every page.
 */
export async function requireSession(): Promise<AuthenticatedUser> {
  const session = await getSession();
  if (!session) {
    const { redirect } = await import('next/navigation');
    redirect('/login');
  }
  // TypeScript doesn't track that redirect() throws a NEXT_REDIRECT
  // error and therefore the code below never runs when session is null.
  // The cast is safe — if we reach this line, session is defined.
  return session as AuthenticatedUser;
}
