import { Inject, Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { databaseErrorCode } from '../database/db-errors';
import type { AppConfig } from '../config/configuration';
import { DUMMY_HASH, hashPassword, verifyPassword } from './utils/password';
import { PasswordResetMailer } from './password-reset-email';
import { passwordPolicyProblem } from './utils/password-policy';
import { generateSessionToken, hashSessionToken, isSessionToken } from './utils/session-token';
import type { AuthenticatedUser, MembershipSummary, SafeUser } from './interfaces/authenticated-user.interface';

/** ADR 0091: a reset link works once and for this long. */
export const PASSWORD_RESET_TTL_MINUTES = 30;

export type PasswordResetResult = { ok: true } | { ok: false; code: 'RESET_TOKEN_INVALID' } | { ok: false; code: 'WEAK_PASSWORD'; message: string };

/** 15 days by default, hard ceiling 30 days. */
export const REMEMBER_DEFAULT_SECONDS = 15 * 24 * 3600;
export const REMEMBER_MAX_SECONDS = 30 * 24 * 3600;

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string | null;
  status: 'ACTIVE' | 'SUSPENDED';
}

function toSafeUser(user: UserRow): SafeUser {
  return { id: user.id, email: user.email, name: user.name, status: user.status };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly sessionTtlSeconds: number;
  private readonly rememberTtlSeconds: number;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly configService: ConfigService<AppConfig>,
    @Optional() @Inject(PasswordResetMailer) private readonly mailer?: PasswordResetMailer,
  ) {
    this.sessionTtlSeconds = this.configService.get('auth.sessionTtlSeconds', { infer: true }) ?? 28800;
    // Business rule (ADR 0091): a remembered session is never shorter than the standard one and never longer than 30 days, whatever the environment says.
    const configured = this.configService.get('auth.rememberSessionTtlSeconds', { infer: true }) ?? REMEMBER_DEFAULT_SECONDS;
    this.rememberTtlSeconds = Math.min(Math.max(configured, this.sessionTtlSeconds), REMEMBER_MAX_SECONDS);
  }

  /**
   * Normalizes an email the same way everywhere it's compared or
   * stored, so "Admin@FBEDS.com" and "admin@fbeds.com" are always
   * treated as the same identity rather than silently creating two
   * accounts.
   */
  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * Authentication events are tenantless, so they are written in a transaction that sets the
   * transaction-local `app.auth_audit` flag the narrow AuditEvent_auth_insert policy requires.
   * A persistence failure never blocks authentication, but it is never silent: it is logged with
   * the action and a database error code only (no payload, email or SQL).
   */
  private async recordAudit(action: string, payload: Prisma.InputJsonObject, userId?: string) {
    if (!this.prisma.auditEvent) return
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.auth_audit', 'true', true)`
        // createMany issues INSERT without RETURNING: tenantless rows have no SELECT policy, and RETURNING would be rejected by it.
        // tenant-scope: tenantless authentication audit event (no tenant exists before login), allowed only under app.auth_audit
        await tx.auditEvent.createMany({
          data: [{ actorType: userId ? 'USER' : 'SYSTEM', action, entityType: 'auth', entityId: userId ?? 'anonymous', payload, userId }],
        })
      })
    } catch (error) {
      this.logger.error(JSON.stringify({ event: 'auth_audit_persist_failed', action, dbCode: databaseErrorCode(error) }))
    }
  }

  private async loadActiveMemberships(userId: string): Promise<MembershipSummary[]> {
    if (!userId || userId.trim() !== userId) throw new Error('A normalized user context is required')
    const memberships = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`
      // tenant-scope: login-time lookup of the caller's own memberships across tenants, keyed by userId under app.current_user_id
      return tx.membership.findMany({
        where: { userId, revokedAt: null, tenant: { status: 'ACTIVE' } },
        include: { tenant: true },
      })
    })
    return memberships.map((m: { tenantId: string; role: string; tenant: { name: string } }) => ({
      tenantId: m.tenantId,
      tenantName: m.tenant.name,
      role: m.role,
    }));
  }

  private async loadServicingMemberships(userId: string): Promise<MembershipSummary[]> {
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`
      // tenant-scope: login-time lookup of the caller's own memberships across tenants, keyed by userId under app.current_user_id
      const rows = await tx.membership.findMany({ where: { userId, revokedAt: null, tenant: { status: 'SUSPENDED' } }, include: { tenant: true } })
      return rows.filter(row => row.tenant.status === 'SUSPENDED').map(row => ({ tenantId: row.tenantId, tenantName: row.tenant.name, role: row.role }))
    })
  }

  /**
   * Validates credentials and, on success, creates a new session.
   * Returns the raw token (for the controller to set as a cookie —
   * never persisted anywhere) and the authenticated identity.
   *
   * Deliberately generic failure for every rejection path (unknown
   * email, wrong password, suspended user) — the caller can't tell
   * which one happened, which is the point (account enumeration).
   */
  async login(rawEmail: string, password: string, rememberMe = false): Promise<{ rawToken: string; identity: AuthenticatedUser; ttlSeconds: number }> {
    const email = this.normalizeEmail(rawEmail);
    const user = await this.prisma.user.findUnique({ where: { email } });

    // Run a real bcrypt comparison even when there's no user or no
    // password set, against a hash no real password matches — keeps
    // response timing consistent across "no such user" and "wrong
    // password" so timing alone doesn't leak which case occurred.
    const hashToCompare = user?.passwordHash ?? DUMMY_HASH;
    const passwordMatches = await verifyPassword(password, hashToCompare);

    if (!user || !user.passwordHash || !passwordMatches || user.status !== 'ACTIVE') {
      await this.recordAudit('auth.login.failure', { reason: 'invalid_credentials' }, user?.id)
      throw new UnauthorizedException('Invalid email or password');
    }

    const rawToken = generateSessionToken();
    const tokenHash = hashSessionToken(rawToken);
    // Absolute expiry: validateSession never extends it, so a remembered session cannot outlive its window.
    const ttlSeconds = rememberMe ? this.rememberTtlSeconds : this.sessionTtlSeconds;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    await this.prisma.$transaction([
      this.prisma.session.create({ data: { userId: user.id, tokenHash, expiresAt } }),
      this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
    ]);

    const memberships = await this.loadActiveMemberships(user.id);
    await this.recordAudit('auth.login.success', { membershipCount: memberships.length, remembered: rememberMe }, user.id)

    return { rawToken, ttlSeconds, identity: { user: toSafeUser(user), memberships, servicingMemberships: await this.loadServicingMemberships(user.id) } };
  }

  /**
   * Validates a raw session token from the cookie. Returns null for
   * any reason the session shouldn't be trusted (missing, expired,
   * revoked, user suspended/deleted) — the guard is responsible for
   * turning that into a 401, this method just tells the truth about
   * whether the session is good.
   */
  async validateSession(rawToken: string): Promise<AuthenticatedUser | null> {
    if (!isSessionToken(rawToken)) return null;
    const tokenHash = hashSessionToken(rawToken);
    const session = await this.prisma.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      if (session?.userId) await this.recordAudit('auth.session.expired_or_revoked', { reason: session.revokedAt ? 'revoked' : 'expired' }, session.userId)
      return null;
    }
    if (session.user.status !== 'ACTIVE') {
      return null;
    }

    // Best-effort activity tracking — not security-critical, so a
    // failure here shouldn't fail the auth check itself.
    void this.prisma.session
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);

    const memberships = await this.loadActiveMemberships(session.user.id);
    return { user: toSafeUser(session.user), memberships, servicingMemberships: await this.loadServicingMemberships(session.user.id) };
  }

  /**
   * Revokes the session matching this raw token, if one exists.
   * Always succeeds — logging out of a session that's already gone
   * (or was never valid) is not an error a caller needs to see,
   * and treating it as one would leak information about session state.
   */
  async logout(rawToken: string | undefined): Promise<void> {
    if (!isSessionToken(rawToken)) return;
    const tokenHash = hashSessionToken(rawToken);
    const session = await this.prisma.session.findUnique({ where: { tokenHash }, select: { userId: true } })
    await this.prisma.session.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.recordAudit('auth.logout', {}, session?.userId)
  }

  /** True when this deployment can really deliver a reset email and knows which portal hosts the reset page (ADR 0091). */
  passwordResetAvailable(): boolean {
    return Boolean(this.mailer?.enabled()) && this.resetOrigins().length > 0;
  }

  private resetOrigins(): string[] {
    return this.configService.get('auth.passwordResetOrigins', { infer: true }) ?? [];
  }

  /**
   * Issues a single-use reset token and emails the link. Returns nothing on purpose: the caller answers every request identically and
   * does not wait for this, so neither the response body nor its timing reveals whether the account exists (ADR 0091).
   * The link origin is checked against the configured allowlist, never taken on trust from the request.
   */
  async requestPasswordReset(rawEmail: string, origin: string | undefined): Promise<void> {
    if (!this.passwordResetAvailable() || !origin || !this.resetOrigins().includes(origin)) return;
    const email = this.normalizeEmail(rawEmail);
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash || user.status !== 'ACTIVE') {
      await this.recordAudit('auth.password_reset.requested', { outcome: 'ignored' }, user?.id);
      return;
    }
    const rawToken = generateSessionToken();
    const now = new Date();
    await this.prisma.$transaction([
      // Earlier unused links stop working: only the newest email is valid.
      this.prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } }),
      this.prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: hashSessionToken(rawToken), expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MINUTES * 60_000) } }),
    ]);
    const sent = await this.mailer!.send(user.email, `${origin}/reset-password?token=${rawToken}`, PASSWORD_RESET_TTL_MINUTES);
    await this.recordAudit('auth.password_reset.requested', { outcome: sent ? 'sent' : 'delivery_failed' }, user.id);
  }

  /**
   * Sets a new password from a valid, unused, unexpired token, and ends every session of that user. The token is consumed in the same
   * transaction as the password change, so a replay or a race can succeed at most once. A weak password is refused without consuming the token.
   */
  async confirmPasswordReset(rawToken: string, newPassword: string): Promise<PasswordResetResult> {
    if (!isSessionToken(rawToken)) return { ok: false, code: 'RESET_TOKEN_INVALID' };
    const record = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash: hashSessionToken(rawToken) }, include: { user: true } });
    if (!record || record.usedAt || record.expiresAt <= new Date() || record.user.status !== 'ACTIVE') {
      await this.recordAudit('auth.password_reset.failed', { reason: !record ? 'unknown' : record.usedAt ? 'used' : record.expiresAt <= new Date() ? 'expired' : 'inactive' }, record?.userId);
      return { ok: false, code: 'RESET_TOKEN_INVALID' };
    }
    const problem = passwordPolicyProblem(newPassword, record.user.email);
    if (problem) return { ok: false, code: 'WEAK_PASSWORD', message: problem };
    const passwordHash = await hashPassword(newPassword);
    const consumed = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const claim = await tx.passwordResetToken.updateMany({ where: { id: record.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
      if (claim.count !== 1) return false;
      await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
      await tx.session.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: now } });
      return true;
    });
    if (!consumed) {
      await this.recordAudit('auth.password_reset.failed', { reason: 'raced' }, record.userId);
      return { ok: false, code: 'RESET_TOKEN_INVALID' };
    }
    await this.recordAudit('auth.password_reset.completed', {}, record.userId);
    return { ok: true };
  }

  async register(email: string, password: string, name?: string): Promise<SafeUser> {
    const normalizedEmail = this.normalizeEmail(email);
    const passwordHash = await hashPassword(password);
    const user = await this.prisma.user.create({
      data: { email: normalizedEmail, name, passwordHash, status: 'ACTIVE' },
    });
    return toSafeUser(user);
  }
}
