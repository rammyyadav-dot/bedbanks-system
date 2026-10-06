/**
 * Which address the lead rate limiter keys on. The right header depends on the proxy in front of the app, and a header the proxy does not
 * overwrite is attacker-controlled, so the mode is explicit:
 *   vercel   (default) Vercel sets x-vercel-forwarded-for itself.
 *   aws-alb  An AWS Application Load Balancer APPENDS the connecting address to X-Forwarded-For, so the LAST entry is the only trustworthy one.
 *            x-vercel-forwarded-for and x-real-ip are ignored: nothing strips them, so a client could set them to dodge the limit.
 */
export type TrustedProxy = 'vercel' | 'aws-alb'

export function trustedProxy(value: string | undefined): TrustedProxy {
  return value === 'aws-alb' ? 'aws-alb' : 'vercel'
}

export function clientAddress(get: (name: string) => string | null, mode: TrustedProxy): string {
  if (mode === 'aws-alb') {
    const entries = (get('x-forwarded-for') ?? '').split(',').map((part) => part.trim()).filter(Boolean)
    return entries[entries.length - 1] ?? 'unknown'
  }
  return get('x-vercel-forwarded-for') ?? get('x-real-ip') ?? get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}
