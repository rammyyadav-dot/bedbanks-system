'use client'

import { useEffect, useState } from 'react'
import { activeTenantHeaders } from '@/lib/api/tenant-context'
import { hotelImageSrc } from '@/lib/data/hotel-images'

/**
 * A hotel image served by the API (ADR 0027). It is fetched with the session cookie and the active-tenant header, because an <img src>
 * cannot send the header and a user in several tenants would otherwise get a broken picture. While loading, or on any failure, it shows
 * `fallback` (never a stand-in picture).
 */
export function AuthImage({ contentPath, alt, width, height, fallback, className, style }: { contentPath: string; alt: string; width: number; height: number; fallback: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let url: string | null = null; let cancelled = false
    const controller = new AbortController()
    fetch(hotelImageSrc(contentPath), { credentials: 'include', headers: activeTenantHeaders(), signal: controller.signal })
      .then((r) => (r.ok && /^image\/(jpeg|png|webp)/.test(r.headers.get('content-type') ?? '') ? r.blob() : Promise.reject(new Error('image'))))
      .then((blob) => { if (cancelled) return; url = URL.createObjectURL(blob); setSrc(url) })
      .catch(() => { if (!cancelled) setSrc(null) })
    return () => { cancelled = true; controller.abort(); if (url) URL.revokeObjectURL(url) }
  }, [contentPath])
  if (!src) return <>{fallback}</>
  return <img src={src} alt={alt} width={width} height={height} loading="lazy" className={className} style={style} data-testid="auth-image" />
}
