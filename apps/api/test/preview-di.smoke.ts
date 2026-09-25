import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { ExecutionContext } from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service';
import { OriginGuard } from '../src/auth/guards/origin.guard';
import { SessionAuthGuard } from '../src/auth/guards/session-auth.guard';
import { PrismaService } from '../src/database/prisma.service';
import { HealthController } from '../src/health/health.controller';

// Run with tsx, like the preview dev runner. Jest's TypeScript transform
// emits constructor metadata and would miss missing explicit Nest tokens.
async function main() {
  const config: Record<string, string> = {
    nodeEnv: 'test',
    adminOrigin: 'http://localhost:3001',
    'auth.cookieName': 'fbeds_session',
  };
  const module = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      OriginGuard,
      SessionAuthGuard,
      { provide: ConfigService, useValue: { get: (key: string) => config[key] } },
      { provide: PrismaService, useValue: { isHealthy: async () => false } },
      { provide: AuthService, useValue: { validateSession: async (token: string) =>
        token === 'test-token' ? { user: { id: 'test-user' }, memberships: [] } : null } },
    ],
  }).compile();

  try {
    const health = await module.get(HealthController).check();
    assert.equal(health.status, 'ok');
    assert.equal(health.database.status, 'unavailable');

    const origin = module.get(OriginGuard);
    const originContext = {
      switchToHttp: () => ({ getRequest: () => ({
        method: 'POST',
        get: (header: string) => header === 'origin' ? 'http://localhost:3001' : undefined,
      }) }),
    } as unknown as ExecutionContext;
    assert.equal(origin.canActivate(originContext), true);

    const session = module.get(SessionAuthGuard);
    const request: { cookies: Record<string, string>; [key: string]: unknown } = {
      cookies: { fbeds_session: 'test-token' },
    };
    const sessionContext = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    assert.equal(await session.canActivate(sessionContext), true);
  } finally {
    await module.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Preview injection smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
