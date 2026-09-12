"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const core_1 = require("@nestjs/core");
const swagger_1 = require("@nestjs/swagger");
const app_module_1 = require("./app.module");
const http_exception_filter_1 = require("./common/filters/http-exception.filter");
const response_interceptor_1 = require("./common/interceptors/response.interceptor");
const logger = new common_1.Logger('Bootstrap');
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule);
    const configService = app.get((config_1.ConfigService));
    const apiPrefix = configService.get('api.prefix', { infer: true }) ?? 'api/v1';
    const port = configService.get('api.port', { infer: true }) ?? 3001;
    const host = configService.get('api.host', { infer: true }) ?? '0.0.0.0';
    const nodeEnv = configService.get('nodeEnv', { infer: true }) ?? 'development';
    app.setGlobalPrefix(apiPrefix);
    app.useGlobalPipes(new common_1.ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
    }));
    app.useGlobalFilters(new http_exception_filter_1.HttpExceptionFilter());
    app.useGlobalInterceptors(new response_interceptor_1.ResponseInterceptor());
    const swaggerConfig = new swagger_1.DocumentBuilder()
        .setTitle('FBEDS API')
        .setDescription('B2B Hotel Bedbank API for wholesale hotel distribution.')
        .setVersion('0.1.0')
        .build();
    const swaggerDocument = swagger_1.SwaggerModule.createDocument(app, swaggerConfig);
    swagger_1.SwaggerModule.setup('api/docs', app, swaggerDocument);
    await app.listen(port, host);
    logger.log(`FBEDS API running in [${nodeEnv}] mode`);
    logger.log(`Listening on http://${host}:${port}/${apiPrefix}`);
    logger.log(`Health check: http://${host}:${port}/${apiPrefix}/health`);
    logger.log(`Swagger docs: http://${host}:${port}/api/docs`);
}
bootstrap().catch((error) => {
    logger.error('FBEDS API failed to start', error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
});
//# sourceMappingURL=main.js.map