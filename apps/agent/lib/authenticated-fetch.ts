import { announceSessionExpired } from './session-events.mjs'

/** Protected portal fetch. HTTP 401 always announces session expiry before the caller reads the body. */
export async function authenticatedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init)
  if (response.status === 401) announceSessionExpired()
  return response
}
