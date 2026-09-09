export interface AppConfig {
  nodeEnv: string;
  api: {
    port: number;
    host: string;
    prefix: string;
  };
}

/**
 * Centralized configuration factory for @nestjs/config.
 *
 * P0-B intentionally only wires up process-level API config (port, host,
 * prefix, environment). Database (DATABASE_URL), Redis, and other
 * infrastructure config are NOT read here yet — that's P0-C's job. This
 * shape is deliberately structured (nested objects, not flat) so P0-C can
 * add a `database` key here without touching anything that already
 * depends on `configuration()`.
 */
export default (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  api: {
    port: parseInt(process.env.API_PORT ?? '3001', 10),
    host: process.env.API_HOST ?? '0.0.0.0',
    prefix: process.env.API_PREFIX ?? 'api/v1',
  },
});
