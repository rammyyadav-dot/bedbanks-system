'use client'

import { useEffect, useState } from 'react'
import type { SearchHotelOffer } from '@bedbanks/domain'
import { agentApiBase } from '@/lib/api-config.mjs'
import { hotelImagePath } from '@/lib/hotel-image.mjs'

/**
 * The hotel's primary image, or the initial mark when there is none or it cannot be loaded (ADR 0027). The image is fetched with the
 * session cookie and the active-tenant header (an <img src> cannot send the header) and shown from a temporary object URL.
 * A failure never shows a broken-image icon and never a stand-in picture.
 */
export function HotelThumbnail({ hotel, tenantId, initial }: { hotel: SearchHotelOffer; tenantId: string; initial: string }) {
  const image = hotel.primaryImage
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!image || !tenantId) { setSrc(null); return }
    let url: string | null = null; let cancelled = false
    const controller = new AbortController()
    fetch(`${agentApiBase}${hotelImagePath(hotel.hotelId, image.imageId)}`, { credentials: 'include', headers: { 'x-fbeds-tenant-id': tenantId }, signal: controller.signal })
      .then((r) => (r.ok && /^image\/(jpeg|png|webp)/.test(r.headers.get('content-type') ?? '') ? r.blob() : Promise.reject(new Error('image'))))
      .then((blob) => { if (cancelled) return; url = URL.createObjectURL(blob); setSrc(url) })
      .catch(() => { if (!cancelled) setSrc(null) })
    return () => { cancelled = true; controller.abort(); if (url) URL.revokeObjectURL(url) }
  }, [hotel.hotelId, image, tenantId])
  if (image && src) return <div className="market-hotel-mark has-image" data-testid="hotel-thumbnail"><img src={src} alt={image.altText} loading="lazy" /></div>
  return <div className="market-hotel-mark" aria-hidden="true">{initial}</div>
}
