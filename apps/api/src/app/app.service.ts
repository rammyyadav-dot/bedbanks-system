import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AppService {
  constructor(private configService: ConfigService) {}

  getHealth() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  getStatus() {
    return {
      app: 'FBEDS Bedbank API',
      version: this.configService.get('API_VERSION', 'v1'),
      environment: this.configService.get('NODE_ENV', 'development'),
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}
