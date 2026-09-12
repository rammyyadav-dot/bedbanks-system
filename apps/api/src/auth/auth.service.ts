import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import type { AppConfig } from '../config/configuration';
import { DUMMY_HASH, hashPassword, verifyPassword } from './utils/password';
import { generateSessionToken, hashSessionToken } from './utils/session-token';
import type { AuthenticatedUser, MembershipSummary, SafeUser } from './interfaces/authenticated-user.interface';

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
  private readonly sessionTtlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<AppConfig>,
  ) {
    this.sessionTtlSeconds = this.configService.get('auth.sessionTtlSeconds', { infer: true }) ?? 28800;
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

  private async loadActiveMemberships(userId: string): Promise<MembershipSummary[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId, tenant: { status: 'ACTIVE' } },
      include: { tenant: true },
    });
    return memberships.map((m) => ({ tenantId: m.tenantId, tenantName: m.tenant.name, role: m.role }));
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
  async login(rawEmail: string, password: string): Promise<{ rawToken: string; identity: AuthenticatedUser }> {
    const email = this.normalizeEmail(rawEmail);
    const user = await this.prisma.user.findUnique({ where: { email } });

    // Run a real bcrypt comparison even when there's no user or no
    // password set, against a hash no real password matches — keeps
    // response timing consistent across "no such user" and "wrong
    // password" so timing alone doesn't leak which case occurred.
    const hashToCompare = user?.passwordHash ?? DUMMY_HASH;
    const passwordMatches = await verifyPassword(password, hashToCompare);

    if (!user || !user.passwordHash || !passwordMatches || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Invalid email or password');
    }

    const rawToken = generateSessionToken();
    const tokenHash = hashSessionToken(rawToken);
    const expiresAt = new Date(Date.now() + this.sessionTtlSeconds * 1000);

    await this.prisma.$transaction([
      this.prisma.session.create({ data: { userId: user.id, tokenHash, expiresAt } }),
      this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
    ]);

    const memberships = await this.loadActiveMemberships(user.id);

    return { rawToken, identity: { user: toSafeUser(user), memberships } };
  }

  /**
   * Validates a raw session token from the cookie. Returns null for
   * any reason the session shouldn't be trusted (missing, expired,
   * revoked, user suspended/deleted) — the guard is responsible for
   * turning that into a 401, this method just tells the truth about
   * whether the session is good.
   */
  async validateSession(rawToken: string): Promise<AuthenticatedUser | null> {
    const tokenHash = hashSessionToken(rawToken);
    const session = await this.prisma.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
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
    return { user: toSafeUser(session.user), memberships };
  }

  /**
   * Revokes the session matching this raw token, if one exists.
   * Always succeeds — logging out of a session that's already gone
   * (or was never valid) is not an error a caller needs to see,
   * and treating it as one would leak information about session state.
   */
  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    const tokenHash = hashSessionToken(rawToken);
    await this.prisma.session.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
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
