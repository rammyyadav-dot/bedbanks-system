import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';
export interface HealthStatus {
    status: 'ok';
    service: string;
    version: string;
    environment: string;
    timestamp: string;
    database: {
        status: 'ok' | 'unavailable';
    };
}
export declare class HealthController {
    private readonly configService;
    private readonly prisma;
    constructor(configService: ConfigService<AppConfig>, prisma: PrismaService);
    check(): Promise<HealthStatus>;
}
