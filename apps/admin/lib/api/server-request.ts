import 'server-only';
import { cookies } from 'next/headers';
import { ApiResponseError } from './errors';
import { apiInternalUrl, apiTrustedOrigin, SESSION_COOKIE_NAME } from './server-env';

const REQUEST_TIMEOUT_MS = 10_000;

/** API request from a Server Component, forwarding the caller's session cookie. */
export async function serverApiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = (await cookies()).get(SESSION_COOKIE_NAME);
  if (!session) throw new ApiResponseError('UNAUTHENTICATED', 'No session.', 401);

  let response: Response;
  try {
    response = await fetch(`${apiInternalUrl()}${path}`, {
      ...init,
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        Origin: apiTrustedOrigin(),
        Cookie: `${SESSION_COOKIE_NAME}=${session.value}`,
        ...init.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new ApiResponseError('API_TIMEOUT', 'The Admin API request timed out.', 504);
    }
    throw new ApiResponseError('NETWORK_ERROR', 'The Admin API could not be reached.', 0);
  }

  const body = await response.json().catch(() => null) as { success?: boolean; data?: T; error?: { code?: string; message?: string } } | null;
  if (!response.ok) throw new ApiResponseError(body?.error?.code ?? 'API_REQUEST_FAILED', body?.error?.message ?? 'The request failed.', response.status);
  if (body?.success !== true) throw new ApiResponseError('INVALID_RESPONSE', 'The Admin API returned an unexpected response.', 502);
  return body.data as T;
}
