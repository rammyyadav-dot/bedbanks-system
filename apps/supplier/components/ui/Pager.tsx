import Link from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'

/** Cursor pagination only offers "first page" and "next page": the API does not expose a previous cursor or a total. */
export function Pager({ shown, noun, firstHref, nextHref }: { shown: number; noun: string; firstHref?: string | null; nextHref?: string | null }) {
  return (
    <nav className="panel-pagination" aria-label={`${noun} pages`}>
      <span>{shown} {noun} on this page</span>
      {firstHref && <Link className="btn" href={firstHref}><ChevronLeft size={15} aria-hidden="true" />First page</Link>}
      {nextHref && <Link className="btn" href={nextHref}>Next page<ChevronRight size={15} aria-hidden="true" /></Link>}
    </nav>
  )
}
