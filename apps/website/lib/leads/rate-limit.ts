/**
 * Best-effort fixed-window limiter. State lives in one server instance, so on serverless
 * hosting it only slows abuse inside a warm instance; it is NOT the primary control. The
 * primary control is an edge rate-limit rule (see README) plus signed, replay-protected
 * downstream requests.
 */
export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number }
export type RateLimiter = { check(key: string): RateLimitResult }

export function createRateLimiter(options: { limit: number; windowMs: number; maxKeys?: number; now?: () => number }): RateLimiter {
  const now = options.now ?? Date.now
  const maxKeys = options.maxKeys ?? 5000
  const windows = new Map<string, { start: number; count: number }>()
  return {
    check(key) {
      const current = now()
      for (const [stored, entry] of windows) if (current - entry.start >= options.windowMs) windows.delete(stored)
      while (windows.size >= maxKeys && !windows.has(key)) windows.delete(windows.keys().next().value as string)
      const entry = windows.get(key)
      if (!entry) { windows.set(key, { start: current, count: 1 }); return { allowed: true } }
      if (entry.count >= options.limit) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.start + options.windowMs - current) / 1000)) }
      entry.count += 1
      return { allowed: true }
    },
  }
}
