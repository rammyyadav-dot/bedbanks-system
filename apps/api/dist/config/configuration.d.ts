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
declare const _default: () => AppConfig;
export default _default;
