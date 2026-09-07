import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  BadRequestException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request } from 'express';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();
    const idempotencyKey = request.headers['x-idempotency-key'] as string;
    const method = request.method;

    // Only validate idempotency key for write operations
    const isWriteOperation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(
      method,
    );

    if (isWriteOperation && idempotencyKey) {
      if (!this.isValidIdempotencyKey(idempotencyKey)) {
        throw new BadRequestException(
          'Invalid idempotency key format. Must be a valid UUID or alphanumeric string.',
        );
      }
    }

    request['idempotencyKey'] = idempotencyKey;

    return next.handle();
  }

  private isValidIdempotencyKey(key: string): boolean {
    // Accept UUID format or alphanumeric string (36 chars max)
    const keyRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[a-zA-Z0-9-_.]{1,36}$/i;
    return keyRegex.test(key);
  }
}
