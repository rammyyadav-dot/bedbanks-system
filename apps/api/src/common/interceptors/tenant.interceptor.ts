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
export class TenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();
    const tenantId =
      (request.headers['x-tenant-id'] as string) ||
      (request.headers['tenant-id'] as string);

    // Validate UUID format (basic check)
    if (tenantId && !this.isValidUUID(tenantId)) {
      throw new BadRequestException(
        'Invalid tenant ID format. Must be a valid UUID.',
      );
    }

    request['tenantId'] = tenantId;

    return next.handle();
  }

  private isValidUUID(uuid: string): boolean {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
  }
}
