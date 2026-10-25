import { Body, Controller, Get, Header, HttpCode, HttpException, HttpStatus, Inject, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { routes } from '@bedbanks/contracts';
import type { Request, Response } from 'express';
import type { AppConfig } from '../config/configuration';
import { OriginGuard } from './guards/origin.guard';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { LoginThrottle } from './login-throttle';
import { SessionAuthGuard } from './guards/session-auth.guard';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';

@ApiTags('auth')
@Controller('auth')
@UseGuards(OriginGuard)
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(ConfigService) private readonly configService: ConfigService<AppConfig>,
    @Inject(LoginThrottle) private readonly throttle: LoginThrottle,
  ) {}

  private cookieOptions(ttlOverrideSeconds?: number): { name: string; httpOnly: true; sameSite: 'lax' | 'strict' | 'none'; secure: boolean; path: string; maxAge: number } {
    const name = this.configService.get('auth.cookieName', { infer: true }) ?? 'fbeds_session';
    const sameSite = this.configService.get('auth.cookieSameSite', { infer: true }) ?? 'lax';
    const secure = this.configService.get('auth.cookieSecure', { infer: true }) ?? true;
    const ttlSeconds = this.configService.get('auth.sessionTtlSeconds', { infer: true }) ?? 28800;
    return { name, httpOnly: true, sameSite, secure, path: '/', maxAge: (ttlOverrideSeconds ?? ttlSeconds) * 1000 };
  }

  @Post('login')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: `${routes.auth.login} — authenticate and receive a session cookie` })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const address = req.ip ?? 'unknown';
    const decision = this.throttle.check(dto.email, address);
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      throw new HttpException({ message: 'Too many sign-in attempts. Try again later.', code: 'LOGIN_THROTTLED' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    let result: Awaited<ReturnType<AuthService['login']>>;
    try {
      result = await this.authService.login(dto.email, dto.password, dto.rememberMe === true);
    } catch (error) {
      if (error instanceof UnauthorizedException) this.throttle.recordFailure(dto.email, address);
      throw error;
    }
    this.throttle.recordSuccess(dto.email, address);
    const { rawToken, identity, ttlSeconds } = result;
    const { name, ...options } = this.cookieOptions(ttlSeconds);
    res.cookie(name, rawToken, options);
    return identity;
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  @UseGuards(SessionAuthGuard)
  @ApiOperation({ summary: `${routes.auth.me} — return the current session identity` })
  me(@CurrentUser() identity: AuthenticatedUser) {
    return identity;
  }

  @Post('logout')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: `${routes.auth.logout} — revoke the current session and clear the cookie` })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { name, maxAge: _maxAge, ...options } = this.cookieOptions();
    const rawToken: string | undefined = (req as { cookies?: Record<string, string> }).cookies?.[name];
    await this.authService.logout(rawToken);
    res.clearCookie(name, options);
    return { loggedOut: true };
  }
}
