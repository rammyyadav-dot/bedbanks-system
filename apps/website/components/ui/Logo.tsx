import Link from 'next/link'

export function Logo({ inverse = false }: { inverse?: boolean }) {
  return <Link href="/" className="brand-logo" aria-label="fBeds home">
    <span className="brand-mark" aria-hidden="true">f</span>
    <span className={inverse ? 'text-white' : 'text-ink'}>fBeds<span className="text-brand">.</span></span>
  </Link>
}
