import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app/app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // API Prefix
  app.setGlobalPrefix(`api/${configService.get('API_VERSION', 'v1')}`);

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Global exception filter
  app.useGlobalFilters(new GlobalExceptionFilter());

  // CORS - configure based on environment
  app.enableCors({
    origin: configService.get('CORS_ORIGIN', '*'),
    credentials: true,
  });

  const port = configService.get('PORT', 3000);
  const nodeEnv = configService.get('NODE_ENV', 'development');

  await app.listen(port, () => {
    logger.log(
      `\n🚀 Bedbank API running on http://localhost:${port}`,
    );
    logger.log(`📦 Environment: ${nodeEnv}`);
    logger.log(`🔧 API Version: ${configService.get('API_VERSION', 'v1')}\n`);
  });
}

bootstrap().catch((err) => {
  console.error('❌ Failed to start application:', err);
  process.exit(1);
});
