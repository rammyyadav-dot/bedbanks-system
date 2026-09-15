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
declare const _default: () => AppConfig;
export default _default;
