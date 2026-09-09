import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration';

export interface HealthStatus {
  status: 'ok';
  service: string;
  version: string;
  environment: string;
  timestamp: string;
}

const SERVICE_NAME = 'fbeds-api';
const SERVICE_VERSION = '0.1.0';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly configService: ConfigService<AppConfig>) {}

  /**
   * Liveness check: confirms the API process is up and responding.
   *
   * Deliberately does NOT check the database, Redis, or any external
   * dependency — P0-B has no database connection to check yet (that's
   * P0-C). This response shape is designed so those checks can be
   * added under additional keys later without breaking existing
   * consumers of this endpoint.
   */
  @Get()
  @ApiOperation({ summary: 'Liveness check for the FBEDS API process' })
  @ApiResponse({
    status: 200,
    description: 'The API process is running.',
  })
  check(): HealthStatus {
    return {
      status: 'ok',
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      environment: this.configService.get('nodeEnv', { infer: true }) ?? 'development',
      timestamp: new Date().toISOString(),
    };
  }
}
