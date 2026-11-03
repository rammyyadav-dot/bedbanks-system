'use client'

import { useEffect, useState, type RefObject } from 'react'
import { windowRange, type WindowRange } from './window-range'

/**
 * The visible slice of a uniform-height list scrolled inside `scrollRef`.
 * Until the scrollport is measured (and whenever `active` is false) every row is included, so a short list and a test renderer stay intact.
 */
export function useVirtualWindow(count: number, rowHeight: number, scrollRef: RefObject<HTMLElement | null>, overscan = 6, active = true): WindowRange {
  const [metrics, setMetrics] = useState<{ scrollTop: number; viewport: number } | null>(null)
  useEffect(() => {
    if (!active) return
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const read = () => setMetrics({ scrollTop: el.scrollTop, viewport: el.clientHeight })
    read()
    el.addEventListener('scroll', read, { passive: true })
    const observer = new ResizeObserver(read)
    observer.observe(el)
    return () => { el.removeEventListener('scroll', read); observer.disconnect() }
  }, [scrollRef, count, active, rowHeight])
  if (!active || !metrics || metrics.viewport <= 0) return { start: 0, end: count, padTop: 0, padBottom: 0 }
  return windowRange({ count, rowHeight, viewport: metrics.viewport, scrollTop: metrics.scrollTop, overscan })
}
