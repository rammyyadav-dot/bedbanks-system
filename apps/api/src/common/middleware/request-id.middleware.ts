import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'X-Request-ID';
/** A caller-supplied id is reused only if it is short and inert; it reaches logs, audit payloads and supplier correlation ids. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

/**
 * Simple request/correlation ID mechanism (spec section 8).
 * - Uses the caller's X-Request-ID header if it is 8-128 characters of [A-Za-z0-9._:-]
 * - Otherwise (absent, oversized, or carrying anything else) generates a UUID
 * - Attaches it to req.requestId so the exception filter can read it
 * - Always echoes it back on the response header
 *
 * Deliberately not a logging framework — just an ID that flows through.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header(REQUEST_ID_HEADER);
    const requestId = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();

    req.requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    next();
  }
}
