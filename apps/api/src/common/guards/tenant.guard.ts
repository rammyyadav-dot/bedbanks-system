import {
  Injectable,
  CanActivate,
  ExecutionContext,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';

@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const tenantId =
      request.headers['x-tenant-id'] || request.headers['tenant-id'];

    if (!tenantId) {
      throw new BadRequestException(
        'Missing tenant identifier. Provide X-Tenant-ID header.',
      );
    }

    request['tenantId'] = tenantId;
    return true;
  }
}
