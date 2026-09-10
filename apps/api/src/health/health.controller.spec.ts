import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { PrismaService } from '../database/prisma.service';

describe('HealthController', () => {
  let controller: HealthController;
  let prisma: { isHealthy: jest.Mock };

  beforeEach(async () => {
    prisma = { isHealthy: jest.fn().mockResolvedValue(true) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => (key === 'nodeEnv' ? 'test' : undefined),
          },
        },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // Test 1: Health endpoint resolves without throwing (HTTP-layer 200
  // is verified in test/health.e2e-spec.ts).
  it('resolves without throwing', async () => {
    await expect(controller.check()).resolves.toBeDefined();
  });

  // Test 3: Response contains data.status = "ok".
  it('returns status "ok"', async () => {
    const result = await controller.check();
    expect(result.status).toBe('ok');
  });

  // Test 4: Response identifies the service as fbeds-api.
  it('identifies the service as fbeds-api', async () => {
    const result = await controller.check();
    expect(result.service).toBe('fbeds-api');
  });

  it('includes a version and an ISO timestamp', async () => {
    const result = await controller.check();
    expect(result.version).toBe('0.1.0');
    expect(() => new Date(result.timestamp).toISOString()).not.toThrow();
  });

  it('reflects the configured environment', async () => {
    const result = await controller.check();
    expect(result.environment).toBe('test');
  });

  it('reports database.status "ok" when Prisma is reachable', async () => {
    prisma.isHealthy.mockResolvedValueOnce(true);
    const result = await controller.check();
    expect(result.database.status).toBe('ok');
  });

  it('reports database.status "unavailable" without throwing when Prisma is unreachable', async () => {
    prisma.isHealthy.mockResolvedValueOnce(false);
    const result = await controller.check();
    expect(result.database.status).toBe('unavailable');
    expect(result.status).toBe('ok'); // process liveness is independent of DB state
  });
});
