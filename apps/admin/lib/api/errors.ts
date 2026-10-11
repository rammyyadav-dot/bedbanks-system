export interface ApiError {
  code: string;
  message: string;
  details: unknown[];
}
export class ApiResponseError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    /** Server request id (x-request-id), shown to operators so a failure can be traced in audit and logs. */
    public readonly requestId: string | null = null,
    /** Field-level validation messages from the API (`error.details`), when present. */
    public readonly details: string[] = [],
    /** Object-valued `error.details` exactly as the API sent them (for example the failed readiness checks of a 409 RATE_PLAN_NOT_READY). Untyped on purpose: callers validate the shape they expect. */
    public readonly structuredDetails: unknown[] = [],
  ) {
    super(message);
    this.name = 'ApiResponseError';
  }
}
