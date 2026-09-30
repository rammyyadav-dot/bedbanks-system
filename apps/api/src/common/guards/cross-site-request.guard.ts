import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Request } from 'express'
import type { AppConfig } from '../../config/configuration'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * CSRF defence for cookie-authenticated mutations. Browsers always attach Origin
 * (and Sec-Fetch-Site) to cross-origin unsafe requests, so a foreign value is
 * rejected. Requests without Origin come from non-browser clients, which cannot
 * ride a victim's cookie, and are left to the normal authentication guards.
 */
@Injectable()
export class CrossSiteRequestGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<AppConfig>) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true
    const req = context.switchToHttp().getRequest<Request>()
    if (SAFE_METHODS.has(req.method.toUpperCase())) return true

    if (req.get('sec-fetch-site')?.toLowerCase() === 'cross-site') {
      throw new ForbiddenException('Untrusted request origin')
    }
    const origin = req.get('origin')
    if (origin !== undefined && origin !== this.config.get('adminOrigin', { infer: true })) {
      throw new ForbiddenException('Untrusted request origin')
    }
    return true
  }
}
