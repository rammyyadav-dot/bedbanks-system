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
  ) {
    super(message);
    this.name = 'ApiResponseError';
  }
}
