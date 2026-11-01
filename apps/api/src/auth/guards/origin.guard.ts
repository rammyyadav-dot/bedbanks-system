import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { AppConfig } from '../../config/configuration';
import { isTrustedOrigin } from '../../config/trusted-origins';

/** CORS alone does not prevent cross-site mutations, including login CSRF. */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<AppConfig>) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
    if (!isTrustedOrigin(this.config, req.get('origin'))) {
      throw new ForbiddenException('Untrusted request origin');
    }
    return true;
  }
}
