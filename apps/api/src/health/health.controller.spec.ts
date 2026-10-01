import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { HealthController, classifyReadiness } from './health.controller';
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

  it('classifies process, database, dependency, and ready states', () => {
    expect(classifyReadiness(true, true)).toBe('ready');
    expect(classifyReadiness(false, true)).toBe('database_unavailable');
    expect(classifyReadiness(false, false)).toBe('database_unavailable');
    expect(classifyReadiness(true, false)).toBe('dependency_unavailable');
  });

  it('reports database.status "ok" when Prisma is reachable', async () => {
    prisma.isHealthy.mockResolvedValueOnce(true);
    const result = await controller.check();
    expect(result.database.status).toBe('ok');
    expect(result.dependencies.status).toBe('ok');
    expect(result.readiness).toBe('ready');
  });

  it('reports database.status "unavailable" without throwing when Prisma is unreachable', async () => {
    prisma.isHealthy.mockResolvedValueOnce(false);
    const result = await controller.check();
    expect(result.database.status).toBe('unavailable');
    expect(result.readiness).toBe('database_unavailable');
    expect(result.status).toBe('ok');
  });

  it('keeps liveness successful when the database check throws a credential-bearing error', async () => {
    prisma.isHealthy.mockRejectedValueOnce(new Error('postgresql://app:secret-password@db.internal/fbeds SELECT 1'));
    const result = await controller.check();
    expect(result.status).toBe('ok');
    expect(result.database.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('secret-password');
    expect(JSON.stringify(result)).not.toContain('postgresql://');
  });

  it('reports ready only when the database is reachable', async () => {
    prisma.isHealthy.mockResolvedValueOnce(true);
    await expect(controller.ready()).resolves.toMatchObject({ status: 'ok', database: { status: 'ok' } });
  });

  it('does not report ready when the database is unreachable', async () => {
    prisma.isHealthy.mockResolvedValueOnce(false);
    await expect(controller.ready()).rejects.toThrow('Database is not ready');
  });

  it('reports dependency unavailable without leaking configuration values', async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: PrismaService, useValue: { isHealthy: jest.fn().mockResolvedValue(true) } },
      ],
    }).compile();
    const degraded = module.get<HealthController>(HealthController);
    const result = await degraded.check();
    expect(result.status).toBe('ok');
    expect(result.database.status).toBe('ok');
    expect(result.dependencies.status).toBe('unavailable');
    expect(result.readiness).toBe('dependency_unavailable');
    expect(JSON.stringify(result)).not.toContain('DATABASE_URL');
    await expect(degraded.ready()).rejects.toThrow('A required dependency is not ready');
  });
});
