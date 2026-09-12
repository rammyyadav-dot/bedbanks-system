import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import type { AppConfig } from './config/configuration';

const logger = new Logger('Bootstrap');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService<AppConfig>);
  const apiPrefix = configService.get('api.prefix', { infer: true }) ?? 'api/v1';
  const port = configService.get('api.port', { infer: true }) ?? 3001;
  const host = configService.get('api.host', { infer: true }) ?? '0.0.0.0';
  const nodeEnv = configService.get('nodeEnv', { infer: true }) ?? 'development';
  const adminOrigin = configService.get('adminOrigin', { infer: true }) ?? 'http://localhost:3000';

  // Required to read the session cookie in SessionAuthGuard.
  app.use(cookieParser());

  // Credentialed CORS, restricted to exactly one explicit origin — a
  // wildcard origin combined with credentials: true would let any
  // website read an authenticated user's session, so this pairing is
  // non-negotiable, not a convenience default.
  app.enableCors({
    origin: adminOrigin,
    credentials: true,
  });

  app.setGlobalPrefix(apiPrefix);

  // Global request validation (spec section 9): reject unknown
  // properties, transform payloads to their DTO types, validate
  // everything against class-validator decorators.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Every thrown exception — HttpException, validation errors, or an
  // unexpected 500 — goes through this filter and comes out as the
  // standard { success: false, error, meta } envelope.
  app.useGlobalFilters(new HttpExceptionFilter());

  // Every successful response gets wrapped as { success: true, data }.
  app.useGlobalInterceptors(new ResponseInterceptor());

  // Swagger/OpenAPI (spec section 11). Chosen path: /api/docs — kept
  // outside the /api/v1 prefix so the docs URL doesn't change on every
  // future API version bump.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('FBEDS API')
    .setDescription('B2B Hotel Bedbank API for wholesale hotel distribution.')
    .setVersion('0.1.0')
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, swaggerDocument);

  await app.listen(port, host);

  logger.log(`FBEDS API running in [${nodeEnv}] mode`);
  logger.log(`Listening on http://${host}:${port}/${apiPrefix}`);
  logger.log(`Health check: http://${host}:${port}/${apiPrefix}/health`);
  logger.log(`Swagger docs: http://${host}:${port}/api/docs`);
}

bootstrap().catch((error: unknown) => {
  // Graceful startup failure: log clearly and exit non-zero, instead of
  // an unhandled promise rejection with a confusing stack dump.
  logger.error('FBEDS API failed to start', error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
