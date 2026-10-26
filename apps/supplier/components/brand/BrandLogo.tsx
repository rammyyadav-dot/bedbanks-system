import Image from 'next/image'

/** fabBeds wordmark. The SVG is static, so it skips the image optimizer. */
export function BrandLogo({ width = 168, variant = 'color', priority = false }: { width?: number; variant?: 'color' | 'white'; priority?: boolean }) {
  const height = Math.round((width * 820) / 3300)
  return (
    <Image
      className="brand-logo"
      src={variant === 'white' ? '/fabbeds-logo-white.svg' : '/fabbeds-logo.svg'}
      alt="fabBeds"
      width={width}
      height={height}
      priority={priority}
      unoptimized
    />
  )
}
