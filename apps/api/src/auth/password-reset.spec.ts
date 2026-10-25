import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { PasswordResetMailer } from './password-reset-email';
import { PrismaService } from '../database/prisma.service';
import { hashPassword, verifyPassword } from './utils/password';
import { hashSessionToken } from './utils/session-token';

jest.setTimeout(20000);

const ORIGIN = 'https://supplier.example';
const TOKEN = 'a'.repeat(64);

describe('password reset (ADR 0091)', () => {
  const user = { id: 'u1', email: 'ops@satguru.example', name: 'Ops', status: 'ACTIVE', passwordHash: 'old-hash' };
  const db = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    session: { updateMany: jest.fn() },
    passwordResetToken: { findUnique: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
  };
  const mailer = { enabled: jest.fn(), send: jest.fn() };
  const config = (origins: string[] = [ORIGIN]) => new ConfigService<any>({ auth: { sessionTtlSeconds: 60, passwordResetOrigins: origins } });
  const make = (origins?: string[]) => new AuthService(db as unknown as PrismaService, config(origins), mailer as unknown as PasswordResetMailer);

  beforeEach(() => {
    jest.clearAllMocks();
    mailer.enabled.mockReturnValue(true);
    mailer.send.mockResolvedValue(true);
    db.user.findUnique.mockResolvedValue(user);
    db.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
    db.passwordResetToken.create.mockResolvedValue({});
    db.session.updateMany.mockResolvedValue({ count: 2 });
    db.user.update.mockResolvedValue({});
    db.$transaction.mockImplementation((input: unknown) => (typeof input === 'function' ? (input as (tx: unknown) => unknown)(db) : Promise.all(input as unknown[])));
  });

  describe('availability', () => {
    it('is on only when email can really be sent and a portal origin is configured', () => {
      expect(make().passwordResetAvailable()).toBe(true);
      expect(make([]).passwordResetAvailable()).toBe(false);
      mailer.enabled.mockReturnValue(false);
      expect(make().passwordResetAvailable()).toBe(false);
      expect(new AuthService(db as unknown as PrismaService, config()).passwordResetAvailable()).toBe(false);
    });
  });

  describe('requestPasswordReset', () => {
    it('stores only the token hash, supersedes older links, and emails a link on the allowed origin', async () => {
      await make().requestPasswordReset(' Ops@Satguru.example ', ORIGIN);
      expect(db.user.findUnique).toHaveBeenCalledWith({ where: { email: user.email } });
      expect(db.passwordResetToken.updateMany).toHaveBeenCalledWith({ where: { userId: 'u1', usedAt: null }, data: { usedAt: expect.any(Date) } });
      const data = db.passwordResetToken.create.mock.calls[0][0].data;
      const [to, link, minutes] = mailer.send.mock.calls[0];
      const raw = new URL(link).searchParams.get('token')!;
      expect(to).toBe(user.email);
      expect(link.startsWith(`${ORIGIN}/reset-password?token=`)).toBe(true);
      expect(raw).toMatch(/^[a-f0-9]{64}$/);
      expect(data.tokenHash).toBe(hashSessionToken(raw));
      expect(JSON.stringify(data)).not.toContain(raw);
      expect(minutes).toBe(30);
      expect(data.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
    });
    it.each([
      ['unknown account', () => db.user.findUnique.mockResolvedValue(null)],
      ['passwordless account', () => db.user.findUnique.mockResolvedValue({ ...user, passwordHash: null })],
      ['suspended account', () => db.user.findUnique.mockResolvedValue({ ...user, status: 'SUSPENDED' })],
    ])('issues nothing and sends nothing for a %s', async (_name, arrange) => {
      arrange();
      await make().requestPasswordReset(user.email, ORIGIN);
      expect(db.passwordResetToken.create).not.toHaveBeenCalled();
      expect(mailer.send).not.toHaveBeenCalled();
    });
    it('ignores an origin that is not on the allowlist (the request body and Origin are never trusted for the link)', async () => {
      await make().requestPasswordReset(user.email, 'https://evil.example');
      await make().requestPasswordReset(user.email, undefined);
      expect(db.user.findUnique).not.toHaveBeenCalled();
      expect(mailer.send).not.toHaveBeenCalled();
    });
    it('does nothing when the feature is off', async () => {
      mailer.enabled.mockReturnValue(false);
      await make().requestPasswordReset(user.email, ORIGIN);
      expect(db.user.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('confirmPasswordReset', () => {
    const record = { id: 't1', userId: 'u1', usedAt: null, expiresAt: new Date(Date.now() + 60_000), user };
    const GOOD = 'a long and sturdy passphrase';

    it('sets the new password, consumes the token and revokes every session, in one transaction', async () => {
      db.passwordResetToken.findUnique.mockResolvedValue(record);
      expect(await make().confirmPasswordReset(TOKEN, GOOD)).toEqual({ ok: true });
      expect(db.passwordResetToken.findUnique).toHaveBeenCalledWith({ where: { tokenHash: hashSessionToken(TOKEN) }, include: { user: true } });
      expect(db.passwordResetToken.updateMany).toHaveBeenCalledWith({ where: { id: 't1', usedAt: null, expiresAt: { gt: expect.any(Date) } }, data: { usedAt: expect.any(Date) } });
      const written = db.user.update.mock.calls[0][0].data.passwordHash;
      expect(written).not.toContain(GOOD);
      expect(await verifyPassword(GOOD, written)).toBe(true);
      expect(db.session.updateMany).toHaveBeenCalledWith({ where: { userId: 'u1', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    });
    it.each([
      ['malformed', () => undefined, 'nope'],
      ['unknown', () => db.passwordResetToken.findUnique.mockResolvedValue(null), TOKEN],
      ['already used', () => db.passwordResetToken.findUnique.mockResolvedValue({ ...record, usedAt: new Date() }), TOKEN],
      ['expired', () => db.passwordResetToken.findUnique.mockResolvedValue({ ...record, expiresAt: new Date(Date.now() - 1) }), TOKEN],
      ['for a suspended user', () => db.passwordResetToken.findUnique.mockResolvedValue({ ...record, user: { ...user, status: 'SUSPENDED' } }), TOKEN],
    ])('rejects a %s token without changing anything', async (_name, arrange, token) => {
      arrange();
      expect(await make().confirmPasswordReset(token, GOOD)).toEqual({ ok: false, code: 'RESET_TOKEN_INVALID' });
      expect(db.user.update).not.toHaveBeenCalled();
      expect(db.session.updateMany).not.toHaveBeenCalled();
    });
    it('refuses a weak password and leaves the token usable', async () => {
      db.passwordResetToken.findUnique.mockResolvedValue(record);
      const result = await make().confirmPasswordReset(TOKEN, 'short');
      expect(result).toMatchObject({ ok: false, code: 'WEAK_PASSWORD' });
      expect(db.passwordResetToken.updateMany).not.toHaveBeenCalled();
      expect(db.user.update).not.toHaveBeenCalled();
    });
    it('loses a race cleanly: if another request consumed the token first, nothing is changed', async () => {
      db.passwordResetToken.findUnique.mockResolvedValue(record);
      db.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });
      expect(await make().confirmPasswordReset(TOKEN, GOOD)).toEqual({ ok: false, code: 'RESET_TOKEN_INVALID' });
      expect(db.user.update).not.toHaveBeenCalled();
      expect(db.session.updateMany).not.toHaveBeenCalled();
    });
  });

  it('hashing works for the policy fixtures', async () => {
    expect(await hashPassword('x'.repeat(12))).toMatch(/^\$2[aby]\$12\$/);
  });
});
