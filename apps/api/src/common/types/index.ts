import { Request } from 'express';
import { JwtPayload } from './jwt-payload.type';

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
  tenantId?: string;
  idempotencyKey?: string;
}

export * from './jwt-payload.type';
export * from './api-response.type';
