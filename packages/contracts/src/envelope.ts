export interface SuccessEnvelope<T> { success: true; data: T }
export interface ErrorEnvelope { success: false; error: { code: string; message: string; details: unknown[] }; meta: { timestamp: string; path: string; requestId: string } }
export type ApiEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;
