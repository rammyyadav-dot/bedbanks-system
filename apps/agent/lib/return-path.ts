const allowedPaths = new Set(['/', '/about', '/support', '/contact', '/news', '/access'])

export function safeReturnPath(value: string | null | undefined): string {
  if (!value) return '/'
  let decoded = value
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return '/'
  }
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.includes('://') || decoded.startsWith('//')) return '/'
  const path = decoded.split('?')[0]?.split('#')[0] ?? ''
  if (!path.startsWith('/') || path.startsWith('//')) return '/'
  return allowedPaths.has(path) ? path : '/'
}
