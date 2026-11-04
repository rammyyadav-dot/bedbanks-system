import { isSuccessEnvelope } from '@bedbanks/contracts'
import type { ApiEnvelope } from '@bedbanks/types'

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

function isEnvelope<T>(value: unknown): value is ApiEnvelope<T> {
  return typeof value === 'object' && value !== null && 'success' in value
}

export function unwrapEnvelope<T>(body: unknown): T {
  if (isSuccessEnvelope<T>(body)) return body.data
  throw new ApiClientError('The API returned an unexpected response.', 502, 'API_MALFORMED_RESPONSE')
}

export function createHttpClient(options: HttpClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/, '')
  const nonExpiring = new Set(options.nonExpiringPaths ?? [])

  return {
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...init?.headers },
      })
      const body: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        if (response.status === 401) {
          if (!nonExpiring.has(path)) options.onUnauthorized?.(path)
          throw new ApiClientError('Session expired', 401)
        }
        if (response.status === 403) throw new ApiClientError('Access denied', 403)
        const message = isEnvelope(body) && body.success === false ? body.error.message : 'Request failed'
        throw new ApiClientError(message, response.status, isEnvelope(body) && body.success === false ? body.error.code : undefined)
      }
      return unwrapEnvelope<T>(body)
    },
  }
}
