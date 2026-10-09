import Image from 'next/image'

export function BrandLogo({ className = '' }: { className?: string }) {
  return <span className={`fabbeds-brand ${className}`}>
    <Image src="/fabbeds-logo.svg" alt="fabBeds" width={3223} height={756} unoptimized />
    <small>THE WORLD’S WHOLESALE MARKETPLACE</small>
  </span>
}
