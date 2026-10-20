import Link from 'next/link'

// The accessible name comes from the visible wordmark (WCAG 2.5.3 label in name); " home" is for screen readers only.
export function Logo({ inverse = false }: { inverse?: boolean }) {
  return <Link href="/" className="brand-logo">
    <span className="brand-mark" aria-hidden="true">f</span>
    <span className={inverse ? 'text-white' : 'text-ink'}>fBeds<span className="text-brand" aria-hidden="true">.</span><span className="sr-only"> home</span></span>
  </Link>
}
