import { OriginGuard } from './guards/origin.guard';
import { Module } from '@nestjs/common';
import { AuthController, RESET_THROTTLE } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginThrottle, RESET_THROTTLE_LIMITS } from './login-throttle';
import { PasswordResetMailer } from './password-reset-email';
import { SesEmailSender } from '../booking-ops/email/ses-email-sender';
import { EMAIL_SENDER } from '../booking-ops/email/email-sender.port';
import { SessionAuthGuard } from './guards/session-auth.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionAuthGuard, OriginGuard, SesEmailSender, { provide: EMAIL_SENDER, useExisting: SesEmailSender }, PasswordResetMailer, { provide: LoginThrottle, useFactory: () => new LoginThrottle() }, { provide: RESET_THROTTLE, useFactory: () => new LoginThrottle(Date.now, RESET_THROTTLE_LIMITS) }],
  exports: [AuthService, SessionAuthGuard],
})
export class AuthModule {}
