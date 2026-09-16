declare enum Environment {
    Development = "development",
    Test = "test",
    Staging = "staging",
    Production = "production"
}
declare class EnvironmentVariables {
    NODE_ENV: Environment;
    API_PORT: number;
    API_HOST: string;
    API_PREFIX: string;
    DATABASE_URL: string;
    AUTH_SESSION_TTL_SECONDS: number;
    AUTH_COOKIE_NAME: string;
    AUTH_COOKIE_SECURE: string;
    AUTH_COOKIE_SAME_SITE: string;
    ADMIN_ORIGIN: string;
}
export declare function validate(config: Record<string, unknown>): EnvironmentVariables;
export {};
