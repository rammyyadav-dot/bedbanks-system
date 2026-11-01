import type { NextFunction, Request, Response } from 'express';

/**
 * Baseline response headers for the JSON API. The API never serves HTML, so the policy is the strictest one:
 * no framing, no sniffing, no referrer leakage, HSTS in production, and `no-store` unless a handler sets its own
 * Cache-Control (authenticated responses carry tenant data and PII and must not sit in a shared cache).
 */
export function securityHeaders(production: boolean) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.removeHeader('X-Powered-By');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Swagger UI (served outside production only) needs inline script, so the docs path keeps the framework default.
    if (!req.path.startsWith('/api/docs')) res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
    next();
  };
}
