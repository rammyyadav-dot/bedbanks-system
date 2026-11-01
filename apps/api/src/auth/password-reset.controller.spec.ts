import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import { LoginThrottle, RESET_THROTTLE_LIMITS } from './login-throttle';

describe('password reset endpoints (ADR 0091)', () => {
  const service = { requestPasswordReset: jest.fn(), confirmPasswordReset: jest.fn(), passwordResetAvailable: jest.fn() };
  const res = { setHeader: jest.fn() } as unknown as Response;
  const req = (ip = '10.0.0.1', origin = 'https://supplier.example') => ({ ip, get: () => origin }) as unknown as Request;
  const build = () => new AuthController(service as unknown as AuthService, new ConfigService<any>({}), new LoginThrottle(), new LoginThrottle(Date.now, RESET_THROTTLE_LIMITS));

  beforeEach(() => { jest.clearAllMocks(); service.requestPasswordReset.mockResolvedValue(undefined); });

  it('answers a request the same way whether or not the account exists, and does not wait for the work', async () => {
    const controller = build();
    let finish!: () => void;
    service.requestPasswordReset.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    expect(controller.requestPasswordReset({ email: 'known@x.co' }, req(), res)).toEqual({ accepted: true });
    expect(controller.requestPasswordReset({ email: 'unknown@x.co' }, req(), res)).toEqual({ accepted: true });
    finish();
  });
  it('swallows a background failure instead of leaking it', async () => {
    service.requestPasswordReset.mockRejectedValue(new Error('smtp down'));
    expect(build().requestPasswordReset({ email: 'a@x.co' }, req(), res)).toEqual({ accepted: true });
    await new Promise((resolve) => setImmediate(resolve));
  });
  it('stops doing work after 3 requests for one account from one address, but still answers 202-style and sets Retry-After', () => {
    const controller = build();
    for (let i = 0; i < 3; i++) controller.requestPasswordReset({ email: 'a@x.co' }, req(), res);
    expect(service.requestPasswordReset).toHaveBeenCalledTimes(3);
    expect(controller.requestPasswordReset({ email: 'a@x.co' }, req(), res)).toEqual({ accepted: true });
    expect(service.requestPasswordReset).toHaveBeenCalledTimes(3);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
  });
  it('maps a confirm result to 200, 400 (invalid or expired link) or 422 (weak password)', async () => {
    const controller = build();
    service.confirmPasswordReset.mockResolvedValueOnce({ ok: true });
    await expect(controller.confirmPasswordReset({ token: 'a'.repeat(64), newPassword: 'x' })).resolves.toEqual({ reset: true });
    service.confirmPasswordReset.mockResolvedValueOnce({ ok: false, code: 'RESET_TOKEN_INVALID' });
    await expect(controller.confirmPasswordReset({ token: 'a'.repeat(64), newPassword: 'x' })).rejects.toMatchObject({ status: 400 });
    service.confirmPasswordReset.mockResolvedValueOnce({ ok: false, code: 'WEAK_PASSWORD', message: 'Use at least 12 characters.' });
    const error = await controller.confirmPasswordReset({ token: 'a'.repeat(64), newPassword: 'x' }).catch((e: HttpException) => e);
    expect((error as HttpException).getStatus()).toBe(422);
    expect((error as HttpException).getResponse()).toMatchObject({ code: 'WEAK_PASSWORD', message: 'Use at least 12 characters.' });
  });
  it('reports the capability from the service', () => {
    service.passwordResetAvailable.mockReturnValue(true);
    expect(build().capabilities()).toEqual({ passwordReset: true });
  });
});
