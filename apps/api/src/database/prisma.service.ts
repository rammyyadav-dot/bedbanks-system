import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Thin wrapper around PrismaClient that plugs into Nest's lifecycle.
 *
 * - Connects explicitly on module init (fails fast at startup if the
 *   database is unreachable, rather than on the first query at
 *   request-time).
 * - Disconnects cleanly on shutdown.
 * - Exposes `isHealthy()` for the health endpoint — a cheap `SELECT 1`,
 *   not a full query against real tables (there's nothing else to
 *   query yet, and liveness/readiness checks should stay cheap).
 *
 * Deliberately just a connection wrapper — no query logic lives here.
 * Domain-specific data access (P1+) belongs in per-resource
 * repositories/services that inject this, not in PrismaService itself.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Database connection closed');
  }

  /**
   * Cheap connectivity check for the health endpoint. Returns false
   * instead of throwing, so a database blip degrades the health
   * response rather than crashing the request.
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.warn(
        `Database health check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
