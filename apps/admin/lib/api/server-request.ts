import 'server-only';
import { cookies } from 'next/headers';
import { parseApiEnvelope } from '@bedbanks/contracts/envelope';
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

  const requestId = response.headers.get('x-request-id');
  const parsed = parseApiEnvelope(response.status, await response.text());
  if (parsed.kind === 'success') return parsed.data as T;
  // Same rule as the browser client: HTTP 2xx without { success: true, data } is not a result.
  if (parsed.kind === 'malformed') throw new ApiResponseError('INVALID_RESPONSE', 'The Admin API returned an unexpected response.', response.status || 502, requestId);
  throw new ApiResponseError(parsed.code ?? 'API_REQUEST_FAILED', parsed.message ?? 'The request failed.', response.status, requestId, parsed.details, parsed.structuredDetails);
}
