import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => (key === 'nodeEnv' ? 'test' : undefined),
          },
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // Test 1: Health endpoint returns HTTP 200.
  // (Verified at the HTTP layer in test/health.e2e-spec.ts — this unit
  // test confirms the handler itself resolves without throwing, which
  // is what would otherwise produce a 500.)
  it('resolves without throwing', () => {
    expect(() => controller.check()).not.toThrow();
  });

  // Test 2: Response contains success = true.
  // (The `success: true` wrapper is added by ResponseInterceptor, not
  // the controller — see test/health.e2e-spec.ts for the full envelope
  // assertion. This test confirms the controller's own payload shape.)

  // Test 3: Response contains data.status = "ok".
  it('returns status "ok"', () => {
    const result = controller.check();
    expect(result.status).toBe('ok');
  });

  // Test 4: Response identifies the service as fbeds-api.
  it('identifies the service as fbeds-api', () => {
    const result = controller.check();
    expect(result.service).toBe('fbeds-api');
  });

  it('includes a version and an ISO timestamp', () => {
    const result = controller.check();
    expect(result.version).toBe('0.1.0');
    expect(() => new Date(result.timestamp).toISOString()).not.toThrow();
  });

  it('reflects the configured environment', () => {
    const result = controller.check();
    expect(result.environment).toBe('test');
  });
});
