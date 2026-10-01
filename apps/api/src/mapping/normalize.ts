const GENERIC_TRAILING = new Set(['hotel', 'hotels', 'resort', 'resorts'])

function fold(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

function tokens(value: string): string[] {
  return fold(value)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
}

/** Collapse only spacing variants of a brand. Meaningful words such as "royal" stay. */
function brandSpacing(parts: string[]): string[] {
  const joined = parts.join(' ')
    .replace(/\bdouble\s+tree\b/g, 'doubletree')
  return joined.split(' ').filter(Boolean)
}

function addressTokens(value: string): string[] {
  const replaced = tokens(value).map((token) => {
    if (token === 'st') return 'street'
    if (token === 'rd') return 'road'
    if (token === 'ave') return 'avenue'
    if (token === 'blvd') return 'boulevard'
    return token
  })
  return brandSpacing(replaced)
}

export interface NormalizedHotel {
  normalizedName: string
  normalizedAddress: string
  normalizedCity: string
  normalizedCountryCode: string
  nameTokens: string[]
}

export function normalizeCountryCode(value: string | null | undefined): string {
  const code = (value ?? '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(code) ? code : ''
}

export function normalizeHotelIdentity(input: {
  name: string
  address?: string | null
  city?: string | null
  countryCode?: string | null
  postalCode?: string | null
  brand?: string | null
}): NormalizedHotel {
  const nameTokens = brandSpacing(tokens([input.brand, input.name].filter(Boolean).join(' ')))
  const address = addressTokens([input.address, input.postalCode].filter(Boolean).join(' '))
  const city = addressTokens(input.city ?? '').join(' ')
  return {
    normalizedName: nameTokens.join(' '),
    normalizedAddress: address.join(' '),
    normalizedCity: city,
    normalizedCountryCode: normalizeCountryCode(input.countryCode),
    nameTokens,
  }
}

export interface NormalizedRoom {
  normalizedName: string
  bedType: string
  view: string
  roomClass: string
}

const BEDS = ['king', 'twin', 'queen', 'double', 'single']
const VIEWS = ['sea', 'ocean', 'beach', 'city', 'garden', 'pool', 'mountain']
const CLASSES = ['executive', 'deluxe', 'superior', 'standard', 'family', 'suite']

function firstMatch(tokens: string[], vocabulary: string[]): string {
  return vocabulary.find((word) => tokens.includes(word)) ?? ''
}

export function normalizeRoomIdentity(input: { name: string; bedType?: string | null; view?: string | null }): NormalizedRoom {
  const parts = brandSpacing(tokens(input.name))
  const bed = firstMatch(tokens(input.bedType ?? ''), BEDS) || firstMatch(parts, BEDS)
  const viewWord = firstMatch(tokens(input.view ?? ''), VIEWS) || firstMatch(parts, VIEWS)
  const view = viewWord === 'ocean' || viewWord === 'beach' ? 'sea' : viewWord
  const roomClass = firstMatch(parts.filter((token) => !GENERIC_TRAILING.has(token)), CLASSES)
  return { normalizedName: parts.join(' '), bedType: bed, view, roomClass }
}

export function tokenSimilarity(left: string, right: string): number {
  const a = left.split(' ').filter(Boolean)
  const b = right.split(' ').filter(Boolean)
  if (!a.length || !b.length) return 0
  const used = new Set<number>()
  let matched = 0
  for (const token of a) {
    let bestIndex = -1
    let bestScore = 0
    for (let index = 0; index < b.length; index += 1) {
      if (used.has(index)) continue
      const score = token === b[index] ? 1 : token.length >= 4 && b[index].length >= 4 ? editSimilarity(token, b[index]) : 0
      if (score > bestScore) { bestScore = score; bestIndex = index }
    }
    if (bestScore >= 0.8 && bestIndex >= 0) { used.add(bestIndex); matched += bestScore }
  }
  return (2 * matched) / (a.length + b.length)
}

function editSimilarity(left: string, right: string): number {
  if (Math.abs(left.length - right.length) > 2) return 0
  const rows = Array.from({ length: left.length + 1 }, (_, index) => index)
  for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
    let previous = rows[0]
    rows[0] = rightIndex
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      const current = rows[leftIndex]
      rows[leftIndex] = left[leftIndex - 1] === right[rightIndex - 1]
        ? previous
        : 1 + Math.min(previous, rows[leftIndex], rows[leftIndex - 1])
      previous = current
    }
  }
  return 1 - rows[left.length] / Math.max(left.length, right.length)
}

export function trigramSimilarity(left: string, right: string): number {
  if (!left || !right) return 0
  if (left === right) return 1
  const a = grams(left)
  const b = grams(right)
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  const union = a.size + b.size - shared
  return union === 0 ? 0 : shared / union
}

function grams(value: string): Set<string> {
  const padded = `  ${value} `
  const found = new Set<string>()
  for (let index = 0; index < padded.length - 2; index += 1) found.add(padded.slice(index, index + 3))
  return found
}
