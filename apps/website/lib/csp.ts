/**
 * Content Security Policy builder. Pure so it can be unit-tested; proxy.ts supplies a fresh
 * per-request nonce. Production allows scripts only through that nonce ('strict-dynamic' lets
 * the nonce'd framework and analytics bootstrap load their own chunks); it never allows
 * 'unsafe-inline' or 'unsafe-eval' for scripts. Development adds only what the dev server needs.
 *
 * Third-party scripts: none are allow-listed. @vercel/analytics loads first-party
 * (/_vercel/insights/script.js, 'self') in production; its debug script on
 * va.vercel-scripts.com is only used outside production, where analytics is disabled.
 */
export function buildContentSecurityPolicy(options: { nonce: string; development: boolean }): string {
  const { nonce, development } = options
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    // Dev only: the Next dev server injects un-nonced <style> tags, and a nonce would make 'unsafe-inline' ignored.
    development ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${development ? ' ws: wss:' : ''}`,
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ]
  if (!development) directives.push('upgrade-insecure-requests')
  return directives.join('; ')
}

/** 128 bits from the Web Crypto CSPRNG, base64 encoded (valid CSP nonce characters). */
export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
