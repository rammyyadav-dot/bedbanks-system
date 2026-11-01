import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common'
import type { Request, Response } from 'express'
import type { DistributionMeResponse } from '@bedbanks/contracts'
import { DistributionAuthGuard, RequireDistributionScope, distributionPrincipal } from './distribution-auth.guard'
import { toWireScopes } from './distribution-credentials'
import { DistributionTokenService } from './distribution-token.service'

/**
 * B2B Distribution API v1 for machine partners (ADR 0075). Partners authenticate with an API key or an OAuth2 bearer token, never a session.
 * Search, CheckRate and Book routes join this controller in later steps; each declares its scope.
 */
@Controller('distribution/v1')
export class DistributionController {
  constructor(private readonly tokens: DistributionTokenService) {}

  /** OAuth 2.0 client credentials. Answers in the RFC 6749 wire format (not the API envelope) so standard OAuth clients work. */
  @Post('oauth/token')
  @HttpCode(200)
  async token(@Req() req: Request, @Res() res: Response, @Body() body: Record<string, unknown>): Promise<void> {
    const outcome = await this.tokens.issue({ authorization: req.header('authorization'), body, requestId: req.requestId })
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    if (outcome.status === 401 && 'basicChallenge' in outcome && outcome.basicChallenge) res.setHeader('WWW-Authenticate', 'Basic realm="fbeds-distribution"')
    res.status(outcome.status).json(outcome.body)
  }

  /** Who the presented credential is. Answers only about the caller, like GET /auth/me, so it needs no scope. */
  @Get('me')
  @UseGuards(DistributionAuthGuard)
  @RequireDistributionScope('SELF')
  me(@Req() req: Request): DistributionMeResponse {
    const principal = distributionPrincipal(req)
    return { clientId: principal.clientId, agencyId: principal.agencyId, authenticatedWith: principal.authenticatedWith, scopes: toWireScopes(principal.scopes), limits: principal.limits }
  }
}
