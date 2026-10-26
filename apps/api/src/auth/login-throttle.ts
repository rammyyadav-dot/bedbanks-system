import { createHash } from 'node:crypto'
import { Injectable } from '@nestjs/common'

/**
 * Failed-login throttle (CTO audit F08). Two counters over a sliding window:
 *   - per account + network address: stops password guessing against one account without letting a stranger lock the
 *     real owner out from another address;
 *   - per network address: stops one address spraying many accounts.
 * A successful login clears the account counter. Keys are hashed, so no email address is kept in memory dumps or logs.
 *
 * State is per API process. With several instances the effective limit is multiplied by the instance count, so the edge
 * (load balancer / WAF) must carry its own rate limit as well; see ADR 0062. The map is capped so it cannot grow without bound.
 */
export const LOGIN_THROTTLE_LIMITS = { windowMs: 15 * 60_000, perAccount: 5, perAddress: 20, maxKeys: 20_000 } as const

export interface ThrottleLimits { windowMs: number; perAccount: number; perAddress: number; maxKeys: number }

/** Password-reset requests: every request counts, so an address cannot use the mailer to flood one inbox or many (ADR 0091). */
export const RESET_THROTTLE_LIMITS: ThrottleLimits = { windowMs: 15 * 60_000, perAccount: 3, perAddress: 20, maxKeys: 20_000 }

export interface ThrottleDecision { allowed: boolean; retryAfterSeconds: number }

@Injectable()
export class LoginThrottle {
  private readonly failures = new Map<string, number[]>()

  constructor(private readonly now: () => number = Date.now, private readonly limits: ThrottleLimits = LOGIN_THROTTLE_LIMITS) {}

  private static key(kind: 'a' | 'i', value: string): string {
    return `${kind}:${createHash('sha256').update(value).digest('hex').slice(0, 32)}`
  }

  private keys(email: string, address: string): { account: string; address: string } {
    return { account: LoginThrottle.key('a', `${email.trim().toLowerCase()}|${address}`), address: LoginThrottle.key('i', address) }
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.limits.windowMs
    const live = (this.failures.get(key) ?? []).filter((at) => at > cutoff)
    if (live.length) this.failures.set(key, live)
    else this.failures.delete(key)
    return live
  }

  /** Call before verifying the password, so a blocked caller costs no password hashing. */
  check(email: string, address: string): ThrottleDecision {
    const k = this.keys(email, address)
    const blocked = [
      { hits: this.recent(k.account), limit: this.limits.perAccount },
      { hits: this.recent(k.address), limit: this.limits.perAddress },
    ].filter((c) => c.hits.length >= c.limit)
    if (!blocked.length) return { allowed: true, retryAfterSeconds: 0 }
    const until = Math.max(...blocked.map((c) => c.hits[c.hits.length - c.limit] + this.limits.windowMs))
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((until - this.now()) / 1000)) }
  }

  recordFailure(email: string, address: string): void {
    const k = this.keys(email, address)
    if (this.failures.size >= this.limits.maxKeys) this.evict()
    for (const key of [k.account, k.address]) this.failures.set(key, [...this.recent(key), this.now()])
  }

  recordSuccess(email: string, address: string): void {
    this.failures.delete(this.keys(email, address).account)
  }

  private evict(): void {
    for (const key of [...this.failures.keys()]) this.recent(key)
    // Still full of live entries: drop the oldest quarter rather than refuse to count new failures.
    if (this.failures.size >= this.limits.maxKeys) {
      for (const key of [...this.failures.keys()].slice(0, Math.ceil(this.limits.maxKeys / 4))) this.failures.delete(key)
    }
  }
}
