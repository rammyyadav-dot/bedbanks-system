import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details: unknown[];
  };
  meta: {
    timestamp: string;
    path: string;
    requestId: string;
  };
}

/**
 * Maps HTTP status codes to a stable, machine-readable error `code`.
 * These codes are part of the API contract — frontends/integrators
 * should branch on `error.code`, not on HTTP status alone or on
 * `error.message` (which is human-readable and may change wording).
 */
const STATUS_CODE_MAP: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_ERROR',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'UNPROCESSABLE_ENTITY',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'INTERNAL_SERVER_ERROR',
};

/**
 * Catches every exception thrown anywhere in the app (NestJS
 * HttpExceptions, ValidationPipe errors, and unexpected/unhandled
 * errors) and normalizes them into one consistent JSON shape.
 *
 * Never leaks stack traces, file paths, or internal error details to
 * the client — those go to the server log only.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, code, message, details } = this.resolveException(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    const errorResponse: ApiErrorResponse = {
      success: false,
      error: { code, message, details },
      meta: {
        timestamp: new Date().toISOString(),
        path: request.url,
        requestId: request.requestId ?? 'unknown',
      },
    };

    response.status(status).json(errorResponse);
  }

  private resolveException(exception: unknown): {
    status: number;
    code: string;
    message: string;
    details: unknown[];
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const code = STATUS_CODE_MAP[status] ?? 'HTTP_ERROR';

      // ValidationPipe throws a BadRequestException whose response body
      // is { message: string[], error: 'Bad Request', statusCode: 400 }.
      if (typeof body === 'object' && body !== null && 'message' in body) {
        const rawMessage = (body as { message: unknown }).message;
        const details = Array.isArray(rawMessage) ? rawMessage : [];
        const message = Array.isArray(rawMessage)
          ? 'Request validation failed'
          : String(rawMessage);
        return { status, code, message, details };
      }

      return {
        status,
        code,
        message: typeof body === 'string' ? body : exception.message,
        details: [],
      };
    }

    // Anything that isn't an HttpException is an unexpected/unhandled
    // error — treat as 500 and never expose its internals.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: STATUS_CODE_MAP[HttpStatus.INTERNAL_SERVER_ERROR],
      message: 'An unexpected error occurred',
      details: [],
    };
  }
}
