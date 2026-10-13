import { OriginGuard } from './guards/origin.guard';
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginThrottle } from './login-throttle';
import { SessionAuthGuard } from './guards/session-auth.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionAuthGuard, OriginGuard, { provide: LoginThrottle, useFactory: () => new LoginThrottle() }],
  exports: [AuthService, SessionAuthGuard],
})
export class AuthModule {}
