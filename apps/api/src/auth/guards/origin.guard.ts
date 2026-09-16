import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { AppConfig } from '../../config/configuration';

/** CORS alone does not prevent cross-site mutations, including login CSRF. */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(private readonly config: ConfigService<AppConfig>) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
    const allowed = this.config.get('adminOrigin', { infer: true });
    if (!allowed || req.get('origin') !== allowed) {
      throw new ForbiddenException('Untrusted request origin');
    }
    return true;
  }
}
