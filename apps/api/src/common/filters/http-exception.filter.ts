import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { COMMERCIAL_CONTROL_UNAVAILABLE, DATABASE_ROLE_NOT_PERMITTED } from '@bedbanks/contracts';
import { databaseErrorCode, isDatabasePermissionDenied } from '../../database/db-errors';
import { CommercialControlUnavailableError, logCommercialControlFailure } from '../../supply/commercial-controls';

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
  [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'INTERNAL_SERVER_ERROR',
};

/** A domain-specific, machine-readable code (e.g. OPERATIONS_READ_DENIED) that an exception may carry in its body. */
const EXPLICIT_CODE = /^[A-Z][A-Z0-9_]{2,47}$/;
function explicitCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('code' in body)) return undefined;
  const code = (body as { code: unknown }).code;
  return typeof code === 'string' && EXPLICIT_CODE.test(code) ? code : undefined;
}

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

    if (exception instanceof CommercialControlUnavailableError) {
      logCommercialControlFailure(this.logger, exception, request.requestId);
    } else if (!(exception instanceof HttpException) && isDatabasePermissionDenied(exception)) {
      // Infrastructure configuration, not a caller decision: structured diagnostic without SQL, table names or values.
      this.logger.error(JSON.stringify({ event: 'database_role_not_permitted', dbCode: databaseErrorCode(exception), method: request.method, path: request.path, requestId: request.requestId ?? 'unknown' }));
    } else if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
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
      const code = explicitCode(body) ?? STATUS_CODE_MAP[status] ?? 'HTTP_ERROR';

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

    // A mandatory commercial control that could not be read (ADR 0031): refuse, never serve unrestricted.
    if (exception instanceof CommercialControlUnavailableError) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: COMMERCIAL_CONTROL_UNAVAILABLE,
        message: 'A required commercial control could not be verified, so the request was refused.',
        details: [],
      };
    }

    // An authorized operation that the runtime database role has no privilege for is a configuration failure, not a 403 (ADR 0031).
    if (isDatabasePermissionDenied(exception)) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: DATABASE_ROLE_NOT_PERMITTED,
        message: 'This operation is not available: the service database role is not configured for it.',
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
