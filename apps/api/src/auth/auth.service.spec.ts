import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { PrismaService } from '../database/prisma.service';
import { hashPassword, DUMMY_HASH, verifyPassword } from './utils/password';
import { generateSessionToken, hashSessionToken } from './utils/session-token';

jest.setTimeout(15000);

describe('opaque session lifecycle', () => {
  const user = { id: 'u1', email: 'admin@example.test', name: 'Admin', status: 'ACTIVE', passwordHash: '' };
  const db = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    session: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    membership: { findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const service = new AuthService(db as unknown as PrismaService, new ConfigService({ auth: { sessionTtlSeconds: 60 } }));
  beforeAll(async () => { user.passwordHash = await hashPassword('correct-password'); });
  beforeEach(() => {
    jest.clearAllMocks();
    db.user.findUnique.mockResolvedValue(user);
    db.membership.findMany.mockResolvedValue([]);
    db.session.update.mockResolvedValue({});
    db.session.updateMany.mockResolvedValue({ count: 1 });
    db.$transaction.mockResolvedValue([]);
  });
  it('creates a unique opaque token, persists only its hash and returns a safe identity', async () => {
    const before = Date.now();
    const result = await service.login(' Admin@Example.Test ', 'correct-password');
    expect(result.rawToken).toMatch(/^[a-f0-9]{64}$/);
    expect(generateSessionToken()).not.toBe(result.rawToken);
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { email: user.email } });
    const data = db.session.create.mock.calls[0][0].data;
    expect(data.tokenHash).toBe(hashSessionToken(result.rawToken));
    expect(JSON.stringify(data)).not.toContain(result.rawToken);
    expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60000);
    expect(result.identity.user).not.toHaveProperty('passwordHash');
  });
  it.each(['missing', 'passwordless', 'wrong', 'suspended'])('rejects %s login generically', async (kind) => {
    db.user.findUnique.mockResolvedValue(kind === 'missing' ? null : { ...user, passwordHash: kind === 'passwordless' ? null : user.passwordHash, status: kind === 'suspended' ? 'SUSPENDED' : 'ACTIVE' });
    await expect(service.login(user.email, kind === 'wrong' ? 'wrong' : 'correct-password')).rejects.toThrow('Invalid email or password');
    expect(db.session.create).not.toHaveBeenCalled();
  });
  it('uses a real cost-12 dummy hash', async () => {
    expect(DUMMY_HASH).toMatch(/^\$2[ab]\$12\$.{53}$/);
    await expect(verifyPassword('unrelated-password', DUMMY_HASH)).resolves.toBe(false);
  });
  it('rejects malformed cookies without a database lookup', async () => {
    await expect(service.validateSession('invalid')).resolves.toBeNull();
    expect(db.session.findUnique).not.toHaveBeenCalled();
  });
  it.each(['missing', 'expired', 'boundary', 'revoked', 'suspended'])('rejects %s sessions', async (kind) => {
    const now = new Date();
    jest.useFakeTimers().setSystemTime(now);
    db.session.findUnique.mockResolvedValue(kind === 'missing' ? null : { id: 's1', user: { ...user, status: kind === 'suspended' ? 'SUSPENDED' : 'ACTIVE' }, revokedAt: kind === 'revoked' ? now : null, expiresAt: new Date(now.getTime() + (kind === 'expired' ? -1 : kind === 'boundary' ? 0 : 60000)) });
    try { await expect(service.validateSession(generateSessionToken())).resolves.toBeNull(); }
    finally { jest.useRealTimers(); }
  });
  it('validates active sessions and loads only active memberships', async () => {
    db.session.findUnique.mockResolvedValue({ id: 's1', user, revokedAt: null, expiresAt: new Date(Date.now() + 60000) });
    const result = await service.validateSession(generateSessionToken());
    expect(result?.user.id).toBe(user.id);
    expect(db.membership.findMany).toHaveBeenCalledWith({ where: { userId: user.id, tenant: { status: 'ACTIVE' } }, include: { tenant: true } });
  });
  it('revokes by hash and tolerates repeated or absent cookies', async () => {
    const raw = generateSessionToken();
    await service.logout(raw);
    await service.logout(raw);
    await service.logout(undefined);
    expect(db.session.updateMany).toHaveBeenCalledTimes(2);
    expect(db.session.updateMany).toHaveBeenCalledWith({ where: { tokenHash: hashSessionToken(raw), revokedAt: null }, data: { revokedAt: expect.any(Date) } });
  });
  it('fails closed on database errors', async () => {
    db.session.findUnique.mockRejectedValueOnce(new Error('unavailable'));
    await expect(service.validateSession(generateSessionToken())).rejects.toThrow('unavailable');
  });
});
