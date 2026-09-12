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
});
//# sourceMappingURL=configuration.js.map