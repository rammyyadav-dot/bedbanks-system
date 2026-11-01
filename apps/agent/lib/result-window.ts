/** Authoritative page window. Offset and total come from the search response; count is the rows on screen. */
export function resultWindow(offset: number, count: number, total: number): { start: number; end: number; total: number } {
  const safeTotal = Number.isSafeInteger(total) && total > 0 ? total : 0
  const safeOffset = Number.isSafeInteger(offset) && offset > 0 ? offset : 0
  const safeCount = Number.isSafeInteger(count) && count > 0 ? count : 0
  if (safeTotal === 0 || safeCount === 0) return { start: 0, end: 0, total: safeTotal }
  const start = safeOffset + 1
  const end = Math.min(safeTotal, safeOffset + safeCount)
  return { start, end: end < start ? start : end, total: safeTotal }
}
