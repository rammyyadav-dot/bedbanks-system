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
}
export declare function validate(config: Record<string, unknown>): EnvironmentVariables;
export {};
