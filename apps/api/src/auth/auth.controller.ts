import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AppConfig } from '../config/configuration';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { SessionAuthGuard } from './guards/session-auth.guard';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService<AppConfig>,
  ) {}

  private cookieOptions(): { name: string; httpOnly: true; sameSite: 'lax' | 'strict' | 'none'; secure: boolean; path: string; maxAge: number } {
    const name = this.configService.get('auth.cookieName', { infer: true }) ?? 'fbeds_session';
    const sameSite = this.configService.get('auth.cookieSameSite', { infer: true }) ?? 'lax';
    const secure = this.configService.get('auth.cookieSecure', { infer: true }) ?? false;
    const ttlSeconds = this.configService.get('auth.sessionTtlSeconds', { infer: true }) ?? 28800;
    return { name, httpOnly: true, sameSite, secure, path: '/', maxAge: ttlSeconds * 1000 };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate and receive a session cookie' })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const { rawToken, identity } = await this.authService.login(dto.email, dto.password);
    const { name, ...options } = this.cookieOptions();
    res.cookie(name, rawToken, options);
    return identity;
  }

  @Get('me')
  @UseGuards(SessionAuthGuard)
  @ApiOperation({ summary: 'Return the identity associated with the current session' })
  me(@CurrentUser() identity: AuthenticatedUser) {
    return identity;
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke the current session and clear the cookie' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { name, path } = this.cookieOptions();
    const rawToken: string | undefined = (req as { cookies?: Record<string, string> }).cookies?.[name];
    await this.authService.logout(rawToken);
    res.clearCookie(name, { path });
    return { loggedOut: true };
  }
}
