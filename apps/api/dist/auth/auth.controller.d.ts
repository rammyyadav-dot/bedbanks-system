import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { AppConfig } from '../config/configuration';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';
export declare class AuthController {
    private readonly authService;
    private readonly configService;
    constructor(authService: AuthService, configService: ConfigService<AppConfig>);
    private cookieOptions;
    login(dto: LoginDto, res: Response): Promise<AuthenticatedUser>;
    me(identity: AuthenticatedUser): AuthenticatedUser;
    logout(req: Request, res: Response): Promise<{
        loggedOut: boolean;
    }>;
}
