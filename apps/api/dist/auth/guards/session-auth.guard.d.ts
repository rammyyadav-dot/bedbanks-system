import { CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration';
import { AuthService } from '../auth.service';
export declare class SessionAuthGuard implements CanActivate {
    private readonly authService;
    private readonly configService;
    constructor(authService: AuthService, configService: ConfigService<AppConfig>);
    canActivate(context: ExecutionContext): Promise<boolean>;
}
