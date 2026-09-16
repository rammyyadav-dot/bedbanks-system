import 'server-only';

/** Strict allowlist: only our opaque cookie, with required security attributes. */
export function parseSessionCookie(headers: string[], name: string) {
  const matches = headers.filter((header) => header.startsWith(`${name}=`));
  if (matches.length !== 1) throw new Error('Missing or ambiguous session cookie');
  const [pair, ...parts] = matches[0].split(';').map((part) => part.trim());
  const value = pair.slice(name.length + 1);
  const attributes = new Map(parts.map((part) => {
    const at = part.indexOf('=');
    return at < 0 ? [part.toLowerCase(), ''] : [part.slice(0, at).toLowerCase(), part.slice(at + 1)];
  }));
  const sameSite = attributes.get('samesite')?.toLowerCase();
  const maxAge = Number(attributes.get('max-age'));
  if (!/^[a-f0-9]{64}$/.test(value) || !attributes.has('httponly') || !attributes.has('secure') ||
      !['lax', 'strict', 'none'].includes(sameSite ?? '') || !Number.isSafeInteger(maxAge) || maxAge <= 0) {
    throw new Error('Invalid session cookie');
  }
  return { value, options: {
    httpOnly: true, secure: true, sameSite: sameSite as 'lax' | 'strict' | 'none',
    path: '/', maxAge,
  } };
}
