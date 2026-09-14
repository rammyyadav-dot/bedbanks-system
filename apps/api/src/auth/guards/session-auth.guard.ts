import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { AppConfig } from '../../config/configuration';
import { AuthService } from '../auth.service';
import { REQUEST_USER_KEY } from '../auth.constants';

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService<AppConfig>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const cookieName = this.configService.get('auth.cookieName', { infer: true }) ?? 'fbeds_session';

    // Deliberately only ever reads the session cookie for identity —
    // never req.body.userId/tenantId, never a query param, never a
    // header the browser could set arbitrarily.
    const rawToken: string | undefined = (request as { cookies?: Record<string, string> }).cookies?.[cookieName];

    if (!rawToken) {
      throw new UnauthorizedException('Not authenticated');
    }

    const identity = await this.authService.validateSession(rawToken);
    if (!identity) {
      throw new UnauthorizedException('Session is invalid or has expired');
    }

    (request as unknown as Record<string, unknown>)[REQUEST_USER_KEY] = identity;
    return true;
  }
}
