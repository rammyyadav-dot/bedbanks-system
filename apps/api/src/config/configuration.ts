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
  auth: {
    sessionTtlSeconds: number;
    cookieName: string;
    cookieSecure: boolean;
    cookieSameSite: 'lax' | 'strict' | 'none';
  };
  adminOrigin: string;
}

/**
 * Centralized configuration factory for @nestjs/config.
 *
 * P0-B wired up process-level API config. P0-C added `database.url`.
 * P0-D adds `auth` (opaque session config) and `adminOrigin` (for
 * credentialed CORS) in the same seam-extension pattern.
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
  auth: {
    sessionTtlSeconds: parseInt(process.env.AUTH_SESSION_TTL_SECONDS ?? '28800', 10),
    cookieName: process.env.AUTH_COOKIE_NAME ?? 'fbeds_session',
    cookieSecure: (process.env.AUTH_COOKIE_SECURE ?? 'false') === 'true',
    cookieSameSite: (process.env.AUTH_COOKIE_SAME_SITE as 'lax' | 'strict' | 'none' | undefined) ?? 'lax',
  },
  adminOrigin: process.env.ADMIN_ORIGIN ?? 'http://localhost:3000',
});
