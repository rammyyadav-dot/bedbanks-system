import Link from 'next/link'

// The accessible name comes from the wordmark's alt text (WCAG 2.5.3 label in name); " home" is for screen readers only.
// Plain <img>: the artwork is a single-colour SVG that needs no optimisation, and next/image injects an inline
// style attribute that the production CSP (style-src without 'unsafe-inline') blocks.
export function Logo() {
  return <Link href="/" className="brand-logo">
    <img src="/fabbeds-logo.svg" alt="fabbeds" width={168} height={40} />
    <span className="sr-only"> home</span>
  </Link>
}
