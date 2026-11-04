export interface SuccessEnvelope<T> { success: true; data: T }
export interface ErrorEnvelope { success: false; error: { code: string; message: string; details: unknown[] }; meta: { timestamp: string; path: string; requestId: string } }
export type ApiEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

/**
 * Fail closed. A 2xx body is success only when it is the API envelope `{ success: true, data }`.
 * `data` may be null. A bare object, `{ data }` without `success: true`, or `success: "true"` is not success.
 */
export function isSuccessEnvelope<T>(value: unknown): value is SuccessEnvelope<T> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as { success?: unknown }).success === true
    && 'data' in value
}

export interface ApiFailureFields {
  code: string | null
  message: string | null
  details: string[]
  structuredDetails: unknown[]
}

/** One reading of a response body. `malformed` is only for HTTP 2xx that is not the success or failure envelope. */
export type ApiEnvelopeParse =
  | { kind: 'success'; data: unknown }
  | ({ kind: 'failure' } & ApiFailureFields)
  | { kind: 'malformed'; reason: string }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function failureFields(value: Record<string, unknown> | null): ApiFailureFields {
  const error = value && isObject(value.error) ? value.error : null
  const details = error && Array.isArray(error.details) ? error.details : []
  return {
    code: error && typeof error.code === 'string' && error.code.length > 0 ? error.code : null,
    message: error && typeof error.message === 'string' && error.message.length > 0 ? error.message : null,
    details: details.filter((item): item is string => typeof item === 'string'),
    structuredDetails: details.filter((item) => item !== null && typeof item === 'object'),
  }
}

/** Parses an already-decoded JSON value. Non-objects are malformed on HTTP 2xx and an empty failure otherwise. */
export function parseApiEnvelopeValue(httpStatus: number, value: unknown): ApiEnvelopeParse {
  const ok = httpStatus >= 200 && httpStatus < 300
  if (!isObject(value)) {
    if (!ok) return { kind: 'failure', code: null, message: null, details: [], structuredDetails: [] }
    return { kind: 'malformed', reason: 'The response was not a JSON object.' }
  }
  if (!ok) return { kind: 'failure', ...failureFields(value) }
  if (value.success === false) return { kind: 'failure', ...failureFields(value) }
  if (value.success === true && 'data' in value) return { kind: 'success', data: value.data }
  return { kind: 'malformed', reason: 'The response was not the API success envelope.' }
}

/**
 * The only envelope reader the portals use. HTTP success is not a successful call: an empty body, HTML from a proxy,
 * truncated JSON, or `{ success: false }` never becomes data. A non-2xx body still yields a failure, even when it is not JSON.
 */
export function parseApiEnvelope(httpStatus: number, text: string): ApiEnvelopeParse {
  if (text.trim() === '') {
    if (httpStatus >= 200 && httpStatus < 300) return { kind: 'malformed', reason: 'The response body was empty.' }
    return { kind: 'failure', code: null, message: null, details: [], structuredDetails: [] }
  }
  let value: unknown
  try { value = JSON.parse(text) } catch {
    if (httpStatus >= 200 && httpStatus < 300) return { kind: 'malformed', reason: 'The response was not valid JSON.' }
    return { kind: 'failure', code: null, message: null, details: [], structuredDetails: [] }
  }
  return parseApiEnvelopeValue(httpStatus, value)
}
