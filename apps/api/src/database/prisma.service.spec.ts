import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  let service: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();

    service = module.get<PrismaService>(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('isHealthy', () => {
    it('returns true when the database responds', async () => {
      jest.spyOn(service, '$queryRaw').mockResolvedValueOnce([{ '?column?': 1 }]);

      await expect(service.isHealthy()).resolves.toBe(true);
    });

    it('returns false instead of throwing when the database is unreachable', async () => {
      jest
        .spyOn(service, '$queryRaw')
        .mockRejectedValueOnce(new Error('connection refused'));

      await expect(service.isHealthy()).resolves.toBe(false);
    });
  });

  describe('lifecycle', () => {
    it('connects on module init', async () => {
      const connectSpy = jest.spyOn(service, '$connect').mockResolvedValueOnce();

      await service.onModuleInit();

      expect(connectSpy).toHaveBeenCalledTimes(1);
    });

    it('disconnects on module destroy', async () => {
      const disconnectSpy = jest
        .spyOn(service, '$disconnect')
        .mockResolvedValueOnce();

      await service.onModuleDestroy();

      expect(disconnectSpy).toHaveBeenCalledTimes(1);
    });
  });
});
