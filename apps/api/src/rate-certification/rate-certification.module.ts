import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { RateCertificationController } from './rate-certification.controller'
import { RateCertificationService } from './rate-certification.service'

@Module({ imports: [AuthModule], controllers: [RateCertificationController], providers: [RateCertificationService] })
export class RateCertificationModule {}
