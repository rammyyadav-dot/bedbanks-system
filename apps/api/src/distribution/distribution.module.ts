import { Module } from '@nestjs/common'
import { DistributionAuthGuard } from './distribution-auth.guard'
import { DistributionController } from './distribution.controller'
import { DistributionTokenService } from './distribution-token.service'

/** B2B Distribution API (ADR 0075). PrismaService comes from the global DatabaseModule. */
@Module({
  controllers: [DistributionController],
  providers: [DistributionAuthGuard, DistributionTokenService],
})
export class DistributionModule {}
