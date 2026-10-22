export const DEFAULT_POST_LOGIN_PATH = '/dashboard';

/**
 * Returns `candidate` only when it is a same-origin relative path that is safe to redirect to after sign-in.
 * Anything else (absolute or protocol-relative URLs, backslashes, control characters, the login page itself,
 * the API proxy) falls back to the dashboard, so `?from=` cannot be used as an open redirect.
 */
export function safePostLoginPath(candidate: unknown): string {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 2048) return DEFAULT_POST_LOGIN_PATH;
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return DEFAULT_POST_LOGIN_PATH;
  if (/[\\\u0000-\u001f\u007f]/.test(candidate)) return DEFAULT_POST_LOGIN_PATH;

  let url: URL;
  try {
    url = new URL(candidate, 'http://admin.invalid');
  } catch {
    return DEFAULT_POST_LOGIN_PATH;
  }
  if (url.origin !== 'http://admin.invalid') return DEFAULT_POST_LOGIN_PATH;
  const { pathname } = url;
  if (pathname === '/' || pathname === '/login' || pathname.startsWith('/login/')) return DEFAULT_POST_LOGIN_PATH;
  if (pathname === '/api' || pathname.startsWith('/api/')) return DEFAULT_POST_LOGIN_PATH;
  return `${pathname}${url.search}`;
}
