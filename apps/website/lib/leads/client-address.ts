/**
 * Which address the lead rate limiter keys on. The right header depends on the proxy in front of the app, and a header the proxy does not
 * overwrite is attacker-controlled, so the mode is explicit:
 *   vercel   (default) Vercel sets x-vercel-forwarded-for itself.
 *   aws-alb  An AWS Application Load Balancer APPENDS the connecting address to X-Forwarded-For, so the LAST entry is the only trustworthy one.
 *            x-vercel-forwarded-for and x-real-ip are ignored: nothing strips them, so a client could set them to dodge the limit.
 *   aws-cloudfront-alb  CloudFront in front of the ALB (ADR 0055): CloudFront appends the viewer address, then the ALB appends CloudFront's
 *            edge address, so the client is the SECOND-TO-LAST entry. Anything left of it is client-supplied and ignored. If there are fewer than
 *            two entries the request did not come through CloudFront and is keyed 'unknown' (shared bucket) rather than trusting a lone entry.
 */
export type TrustedProxy = 'vercel' | 'aws-alb' | 'aws-cloudfront-alb'

export function trustedProxy(value: string | undefined): TrustedProxy {
  return value === 'aws-alb' || value === 'aws-cloudfront-alb' ? value : 'vercel'
}

export function clientAddress(get: (name: string) => string | null, mode: TrustedProxy): string {
  if (mode === 'aws-alb') {
    const entries = (get('x-forwarded-for') ?? '').split(',').map((part) => part.trim()).filter(Boolean)
    return entries[entries.length - 1] ?? 'unknown'
  }
  if (mode === 'aws-cloudfront-alb') {
    const entries = (get('x-forwarded-for') ?? '').split(',').map((part) => part.trim()).filter(Boolean)
    return entries.length >= 2 ? entries[entries.length - 2]! : 'unknown'
  }
  return get('x-vercel-forwarded-for') ?? get('x-real-ip') ?? get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}
