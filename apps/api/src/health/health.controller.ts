import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';

export type Readiness = 'ready' | 'database_unavailable' | 'dependency_unavailable';

export interface HealthStatus {
  status: 'ok';
  service: string;
  version: string;
  environment: string;
  timestamp: string;
  database: {
    status: 'ok' | 'unavailable';
  };
  dependencies: {
    status: 'ok' | 'unavailable';
  };
  readiness: Readiness;
}

/** Process liveness stays `ok` whenever this function runs. Database failure is reported before any other dependency. */
export function classifyReadiness(databaseHealthy: boolean, dependenciesHealthy: boolean): Readiness {
  if (!databaseHealthy) return 'database_unavailable';
  if (!dependenciesHealthy) return 'dependency_unavailable';
  return 'ready';
}

const SERVICE_NAME = 'fbeds-api';
const SERVICE_VERSION = '0.1.0';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService<AppConfig>,
    @Inject(PrismaService) private readonly prisma: PrismaService,
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
    return this.snapshot(await this.databaseHealthy(), this.dependenciesHealthy());
  }

  /**
   * Readiness for the process host. Liveness stays on `GET /health` so a
   * transient database blip does not hide that the process is up. This
   * route is not successful while the database is unreachable.
   */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness check. Not successful while the database is unavailable.' })
  @ApiResponse({ status: 200, description: 'The process can serve traffic and the database is reachable.' })
  @ApiResponse({ status: 503, description: 'The database is not ready.' })
  async ready(): Promise<HealthStatus> {
    const databaseHealthy = await this.databaseHealthy();
    const dependenciesHealthy = this.dependenciesHealthy();
    if (!databaseHealthy) {
      throw new ServiceUnavailableException('Database is not ready');
    }
    if (!dependenciesHealthy) {
      throw new ServiceUnavailableException('A required dependency is not ready');
    }
    return this.snapshot(true, true);
  }

  private async databaseHealthy(): Promise<boolean> {
    try {
      return await this.prisma.isHealthy();
    } catch {
      return false;
    }
  }

  private dependenciesHealthy(): boolean {
    const environment = this.configService.get('nodeEnv', { infer: true });
    return typeof environment === 'string' && environment.length > 0;
  }

  private snapshot(databaseHealthy: boolean, dependenciesHealthy: boolean): HealthStatus {
    return {
      status: 'ok',
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      environment: this.configService.get('nodeEnv', { infer: true }) ?? 'development',
      timestamp: new Date().toISOString(),
      database: {
        status: databaseHealthy ? 'ok' : 'unavailable',
      },
      dependencies: {
        status: dependenciesHealthy ? 'ok' : 'unavailable',
      },
      readiness: classifyReadiness(databaseHealthy, dependenciesHealthy),
    };
  }
}
