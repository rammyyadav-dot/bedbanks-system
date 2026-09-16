import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import type { AppConfig } from '../config/configuration';
import type { AuthenticatedUser, SafeUser } from './interfaces/authenticated-user.interface';
export declare class AuthService {
    private readonly prisma;
    private readonly configService;
    private readonly sessionTtlSeconds;
    constructor(prisma: PrismaService, configService: ConfigService<AppConfig>);
    private normalizeEmail;
    private loadActiveMemberships;
    login(rawEmail: string, password: string): Promise<{
        rawToken: string;
        identity: AuthenticatedUser;
    }>;
    validateSession(rawToken: string): Promise<AuthenticatedUser | null>;
    logout(rawToken: string | undefined): Promise<void>;
    register(email: string, password: string, name?: string): Promise<SafeUser>;
}
