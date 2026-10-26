import { ForbiddenException, HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'
import { AgentAuditService } from '../agent/audit.service'
import { LoginThrottle, type ThrottleLimits } from '../auth/login-throttle'
import { DUMMY_HASH, verifyPassword } from '../auth/utils/password'
import { currentRequestContext } from '../common/request-context'

// The body field is part of the API contract (@bedbanks/contracts). The guard removes it before any handler, log or audit writer can see it.
export { STEP_UP_FIELD } from '@bedbanks/contracts'
const MAX_PASSWORD_LENGTH = 256

/** Stricter than sign-in: a signed-in session is already trusted, so a wrong password here is a stronger signal. Per API process (see LoginThrottle). */
export const STEP_UP_LIMITS: ThrottleLimits = { windowMs: 15 * 60_000, perAccount: 5, perAddress: 20, maxKeys: 20_000 }

export interface StepUpInput {
  tenantId: string
  userId: string
  /** Untrusted: whatever the request body held in STEP_UP_FIELD. */
  password: unknown
  /** The permission key being exercised, for example `markup.activate`. Audit only. */
  action: string
  entityId: string
}

/**
 * Password re-verification for the checker of a maker-checker decision (ADR 0095). The session proves who is signed in; this proves the
 * same person is at the keyboard right now. It is not a second factor and does not replace the different-person rule, which the approval
 * service and the database enforce. TOTP is not built: it needs encrypted secret storage and an enrolment flow, which are separate decisions.
 *
 * Every attempt is audited with the caller's address (success, wrong password, missing password, throttled). The password is never stored or logged.
 */
@Injectable()
export class StepUpService {
  private readonly throttle = new LoginThrottle(Date.now, STEP_UP_LIMITS)

  constructor(private readonly prisma: PrismaService, private readonly audit: AgentAuditService) {}

  async verify(input: StepUpInput): Promise<void> {
    const address = currentRequestContext()?.ip ?? 'unknown'
    const record = (action: string, extra: Record<string, unknown> = {}) => this.audit.record({
      tenantId: input.tenantId, userId: input.userId, action, entityType: 'step_up', entityId: input.entityId, payload: { approvalAction: input.action, ...extra },
    })
    const deny = async (action: string, code: string, message: string): Promise<never> => {
      await record(action).catch(() => undefined)
      throw new ForbiddenException({ message, code })
    }

    if (typeof input.password !== 'string' || input.password.length === 0 || input.password.length > MAX_PASSWORD_LENGTH) {
      return deny('step_up.missing', 'STEP_UP_REQUIRED', 'Confirm your password to continue')
    }
    const gate = this.throttle.check(input.userId, address)
    if (!gate.allowed) {
      await record('step_up.throttled', { retryAfterSeconds: gate.retryAfterSeconds }).catch(() => undefined)
      throw new HttpException({ message: 'Too many failed confirmations; try again later', code: 'STEP_UP_THROTTLED', retryAfterSeconds: gate.retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS)
    }

    const user = await this.prisma.user.findUnique({ where: { id: input.userId } })
    // Always run a real comparison so timing does not separate "no password set" from "wrong password".
    const matches = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH)
    if (!user || !user.passwordHash || !matches || user.status !== 'ACTIVE') {
      this.throttle.recordFailure(input.userId, address)
      return deny('step_up.failed', 'STEP_UP_FAILED', 'The password is not correct')
    }
    this.throttle.recordSuccess(input.userId, address)
    // A verified step-up that cannot be recorded must not proceed.
    await record('step_up.verified')
  }
}
