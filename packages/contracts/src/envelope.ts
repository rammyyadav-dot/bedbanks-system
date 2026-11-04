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
