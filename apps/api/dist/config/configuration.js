"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = () => ({
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
        cookieSameSite: process.env.AUTH_COOKIE_SAME_SITE ?? 'lax',
    },
    adminOrigin: process.env.ADMIN_ORIGIN ?? 'http://localhost:3000',
});
//# sourceMappingURL=configuration.js.map