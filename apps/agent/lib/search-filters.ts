import type { SearchCriteria } from '@bedbanks/domain'
import { majorUnitsToMinor, minorUnitExponent, minorUnitsToMajorInput } from '@bedbanks/money'

export const SELLING_CURRENCIES = ['AED', 'USD', 'EUR', 'GBP', 'INR', 'SAR', 'QAR', 'OMR', 'KWD', 'BHD', 'SGD', 'AUD', 'CAD', 'JPY'] as const
export type SellingCurrency = typeof SELLING_CURRENCIES[number]

export type FilterDraft = {
  starRatings: number[]
  refundableOnly: boolean
  minPrice: string
  maxPrice: string
  currency: string
  boardBasisIds: string[]
  propertyTypes: string[]
}

export function parseMajorAmount(input: string, currency: string): { state: 'empty' } | { state: 'invalid' } | { state: 'minor'; minor: number } {
  const trimmed = input.trim()
  if (!trimmed) return { state: 'empty' }
  try {
    minorUnitExponent(currency)
    const minor = majorUnitsToMinor(trimmed, currency)
    return { state: 'minor', minor }
  } catch {
    return { state: 'invalid' }
  }
}

export function minorToMajorInput(minor: number | undefined, currency: string): string {
  if (minor === undefined) return ''
  try { return minorUnitsToMajorInput(minor, currency) } catch { return '' }
}

export function criteriaFilters(draft: FilterDraft): { ok: true; filters?: NonNullable<SearchCriteria['filters']> } | { ok: false; reason: string } {
  const starRatings = [...new Set(draft.starRatings.filter((value) => Number.isInteger(value) && value >= 1 && value <= 5))].sort((a, b) => a - b)
  const min = parseMajorAmount(draft.minPrice, draft.currency)
  const max = parseMajorAmount(draft.maxPrice, draft.currency)
  if (min.state === 'invalid' || max.state === 'invalid') return { ok: false, reason: `Enter the price range in ${draft.currency} using that currency's decimal places.` }
  if (min.state === 'minor' && max.state === 'minor' && max.minor < min.minor) return { ok: false, reason: 'The maximum price must be at least the minimum price.' }
  const boardBasisIds = [...new Set(draft.boardBasisIds.filter((value) => value.trim().length > 0))].sort()
  const propertyTypes = [...new Set(draft.propertyTypes.filter((value) => value.trim().length > 0))].sort()
  const filters: NonNullable<SearchCriteria['filters']> = {}
  if (starRatings.length) filters.starRatings = starRatings
  if (draft.refundableOnly) filters.refundableOnly = true
  if (min.state === 'minor') filters.minPriceMinor = min.minor
  if (max.state === 'minor') filters.maxPriceMinor = max.minor
  if (boardBasisIds.length) filters.boardBasisIds = boardBasisIds
  if (propertyTypes.length) filters.propertyTypes = propertyTypes
  return { ok: true, ...(Object.keys(filters).length ? { filters } : {}) }
}
