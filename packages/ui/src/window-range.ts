/** The slice of a uniform-height list that intersects the scrollport, plus spacer sizes for the rows above and below it. */
export interface WindowRange { start: number; end: number; padTop: number; padBottom: number }

export function windowRange(input: { count: number; rowHeight: number; viewport: number; scrollTop: number; overscan?: number }): WindowRange {
  const count = Math.max(0, Math.floor(input.count))
  const rowHeight = input.rowHeight
  const overscan = input.overscan ?? 6
  if (count === 0 || rowHeight <= 0 || input.viewport <= 0) return { start: 0, end: count, padTop: 0, padBottom: 0 }
  const scrollTop = Math.max(0, input.scrollTop)
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(count, Math.ceil((scrollTop + input.viewport) / rowHeight) + overscan)
  return { start, end: Math.max(start, end), padTop: start * rowHeight, padBottom: Math.max(0, (count - Math.max(start, end)) * rowHeight) }
}
