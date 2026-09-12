export interface AppConfig {
  nodeEnv: string;
  api: {
    port: number;
    host: string;
    prefix: string;
  };
  database: {
    url: string;
  };
}

/**
 * Centralized configuration factory for @nestjs/config.
 *
 * P0-B only wired up process-level API config. P0-C adds `database.url`
 * here, in the shape the original P0-B comment anticipated — nothing
 * that already depended on `configuration()` needed to change.
 */
export default (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  api: {
    port: parseInt(process.env.API_PORT ?? '3001', 10),
    host: process.env.API_HOST ?? '0.0.0.0',
    prefix: process.env.API_PREFIX ?? 'api/v1',
  },
  database: {
    url: process.env.DATABASE_URL ?? '',
  },
});
