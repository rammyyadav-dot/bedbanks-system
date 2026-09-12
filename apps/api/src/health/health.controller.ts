import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
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

const SERVICE_NAME = 'fbeds-api';
const SERVICE_VERSION = '0.1.0';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly configService: ConfigService<AppConfig>,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Liveness + basic readiness check.
   *
   * `status: 'ok'` reflects the API process itself — always 'ok' if
   * this handler runs at all. `database.status` is a separate field:
   * a database blip degrades that field to 'unavailable' without
   * making the whole endpoint return non-200, since a load balancer
   * killing/restarting the process over a transient DB hiccup is
   * usually the wrong response. Callers that need to distinguish
   * "process up" from "fully ready" should check both fields.
   */
  @Get()
  @ApiOperation({ summary: 'Liveness and basic readiness check for the FBEDS API' })
  @ApiResponse({
    status: 200,
    description: 'The API process is running. Check database.status for DB connectivity.',
  })
  async check(): Promise<HealthStatus> {
    const databaseHealthy = await this.prisma.isHealthy();

    return {
      status: 'ok',
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      environment: this.configService.get('nodeEnv', { infer: true }) ?? 'development',
      timestamp: new Date().toISOString(),
      database: {
        status: databaseHealthy ? 'ok' : 'unavailable',
      },
    };
  }
}
