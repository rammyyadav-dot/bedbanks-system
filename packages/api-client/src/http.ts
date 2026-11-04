import { parseApiEnvelope, parseApiEnvelopeValue } from '@bedbanks/contracts/envelope'

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiClientError'
  }
}

export type HttpClientOptions = {
  baseUrl: string
  /** Called on HTTP 401 except for paths listed in `nonExpiringPaths`. */
  onUnauthorized?: (path: string) => void
  nonExpiringPaths?: readonly string[]
}

/** Reads a success envelope. Anything else throws; a bare JSON object is never treated as data. */
export function unwrapEnvelope<T>(body: unknown): T {
  const parsed = parseApiEnvelopeValue(200, body)
  if (parsed.kind === 'success') return parsed.data as T
  const status = parsed.kind === 'failure' ? 200 : 502
  const code = parsed.kind === 'failure' ? parsed.code ?? 'API_REQUEST_FAILED' : 'API_MALFORMED_RESPONSE'
  const message = parsed.kind === 'failure' ? parsed.message ?? 'Request failed' : 'The API returned an unexpected response.'
  throw new ApiClientError(message, status, code)
}

export function createHttpClient(options: HttpClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/, '')
  const nonExpiring = new Set(options.nonExpiringPaths ?? [])

  return {
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      let response: Response
      try {
        response = await fetch(`${baseUrl}${path}`, {
          ...init,
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...init?.headers },
        })
      } catch {
        throw new ApiClientError('Request failed', 0, 'NETWORK_ERROR')
      }
      let text: string
      try {
        text = await response.text()
      } catch {
        throw new ApiClientError('Request failed', 0, 'NETWORK_ERROR')
      }
      if (response.status === 401) {
        if (!nonExpiring.has(path)) options.onUnauthorized?.(path)
        throw new ApiClientError('Session expired', 401)
      }
      if (response.status === 403) throw new ApiClientError('Access denied', 403)
      const parsed = parseApiEnvelope(response.status, text)
      if (parsed.kind === 'success') return parsed.data as T
      if (parsed.kind === 'failure') throw new ApiClientError(parsed.message ?? 'Request failed', response.status, parsed.code ?? 'API_REQUEST_FAILED')
      throw new ApiClientError('The API returned an unexpected response.', response.status, 'API_MALFORMED_RESPONSE')
    },
  }
}
