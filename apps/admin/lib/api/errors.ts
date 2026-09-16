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
  ) {
    super(message);
    this.name = 'ApiResponseError';
  }
}

