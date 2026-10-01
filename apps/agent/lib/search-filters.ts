import type { SearchCriteria } from '@bedbanks/domain'

const MAX_MINOR = BigInt(Number.MAX_SAFE_INTEGER)

export type FilterDraft = {
  starRatings: number[]
  refundableOnly: boolean
  minPriceAed: string
  maxPriceAed: string
}

export function parseWholeAmountMinor(input: string): { state: 'empty' } | { state: 'invalid' } | { state: 'minor'; minor: number } {
  const trimmed = input.trim()
  if (!trimmed) return { state: 'empty' }
  if (!/^\d+$/.test(trimmed)) return { state: 'invalid' }
  const minor = BigInt(trimmed) * 100n
  if (minor > MAX_MINOR) return { state: 'invalid' }
  return { state: 'minor', minor: Number(minor) }
}

export function minorToWholeAmount(minor: number | undefined): string {
  if (minor === undefined || !Number.isSafeInteger(minor) || minor < 0) return ''
  const value = BigInt(minor)
  if (value % 100n !== 0n) return ''
  return (value / 100n).toString()
}

export function criteriaFilters(draft: FilterDraft): { ok: true; filters?: NonNullable<SearchCriteria['filters']> } | { ok: false; reason: string } {
  const starRatings = [...new Set(draft.starRatings.filter((value) => Number.isInteger(value) && value >= 1 && value <= 5))].sort((a, b) => a - b)
  const min = parseWholeAmountMinor(draft.minPriceAed)
  const max = parseWholeAmountMinor(draft.maxPriceAed)
  if (min.state === 'invalid' || max.state === 'invalid') return { ok: false, reason: 'Enter the price range in whole AED amounts.' }
  if (min.state === 'minor' && max.state === 'minor' && max.minor < min.minor) return { ok: false, reason: 'The maximum price must be at least the minimum price.' }
  const filters: NonNullable<SearchCriteria['filters']> = {}
  if (starRatings.length) filters.starRatings = starRatings
  if (draft.refundableOnly) filters.refundableOnly = true
  if (min.state === 'minor') filters.minPriceMinor = min.minor
  if (max.state === 'minor') filters.maxPriceMinor = max.minor
  return { ok: true, ...(Object.keys(filters).length ? { filters } : {}) }
}
