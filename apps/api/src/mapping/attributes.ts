/**
 * Canonical vocabularies and strong-identifier normalizers for supplier mapping.
 * Unknown input is returned as null and surfaced for review. It is never guessed.
 */

export type BoardBasisCode = 'RO' | 'BB' | 'HB' | 'FB' | 'AI'

const BOARD_PHRASES: Array<[BoardBasisCode, string[]]> = [
  // Longest-first within the table order: "all inclusive" must win over "inclusive" style fragments of other boards.
  ['AI', ['ultra all inclusive', 'all inclusive', 'allinclusive', 'all inc']],
  ['FB', ['full board', 'full pension', 'american plan', 'breakfast lunch and dinner']],
  ['HB', ['half board', 'half pension', 'demi pension', 'demi board', 'modified american plan', 'dinner bed and breakfast', 'breakfast and dinner']],
  ['BB', ['bed and breakfast', 'bed breakfast', 'breakfast included', 'with breakfast', 'continental breakfast', 'buffet breakfast', 'english breakfast', 'american breakfast', 'full breakfast', 'continental plan']],
  ['RO', ['room only', 'accommodation only', 'no meals', 'without meals', 'european plan', 'sleep only']],
]

const BOARD_CODES: Record<string, BoardBasisCode> = {
  ro: 'RO', ep: 'RO', bb: 'BB', cp: 'BB', hb: 'HB', dbb: 'HB', map: 'HB', fb: 'FB', ap: 'FB', ai: 'AI', uai: 'AI',
}

function words(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
}

/** Maps supplier meal-plan wording to one canonical code. Conflicting or unknown wording returns null. */
export function normalizeBoardBasis(input: string | null | undefined): BoardBasisCode | null {
  const text = words(input ?? '')
  if (!text) return null
  const whole = BOARD_CODES[text]
  if (whole) return whole

  const found = new Set<BoardBasisCode>()
  const padded = ` ${text} `
  for (const [code, phrases] of BOARD_PHRASES) {
    if (phrases.some((phrase) => padded.includes(` ${phrase} `))) found.add(code)
  }
  if (found.size === 0) {
    // Short codes only count as standalone tokens ("Standard Room BB"), and only when they agree.
    for (const token of text.split(' ')) if (token.length <= 3 && BOARD_CODES[token]) found.add(BOARD_CODES[token])
  }
  // Wording that implies several boards ("half board or full board") is ambiguous; a human decides.
  return found.size === 1 ? [...found][0] : null
}

export type AmenityCode =
  | 'WIFI' | 'POOL' | 'SPA' | 'GYM' | 'PARKING' | 'AIRPORT_SHUTTLE' | 'AIR_CONDITIONING' | 'RESTAURANT' | 'BAR'
  | 'BEACH_ACCESS' | 'PETS_ALLOWED' | 'ROOM_SERVICE' | 'KIDS_CLUB' | 'BUSINESS_CENTER' | 'LAUNDRY' | 'ACCESSIBLE'

const AMENITY_SYNONYMS: Record<AmenityCode, string[]> = {
  WIFI: ['wifi', 'wi fi', 'wireless internet', 'free wifi', 'internet access', 'wireless'],
  POOL: ['pool', 'swimming pool', 'outdoor pool', 'indoor pool', 'infinity pool', 'rooftop pool'],
  SPA: ['spa', 'spa and wellness', 'wellness centre', 'wellness center', 'sauna', 'hammam'],
  GYM: ['gym', 'fitness centre', 'fitness center', 'fitness room', 'health club', 'workout room'],
  PARKING: ['parking', 'free parking', 'car park', 'valet parking', 'onsite parking', 'on site parking'],
  AIRPORT_SHUTTLE: ['airport shuttle', 'airport transfer', 'airport transfers', 'shuttle service', 'airport pickup'],
  AIR_CONDITIONING: ['air conditioning', 'air conditioned', 'a c', 'ac', 'climate control'],
  RESTAURANT: ['restaurant', 'on site restaurant', 'onsite restaurant', 'dining'],
  BAR: ['bar', 'lounge', 'pub', 'cocktail bar'],
  BEACH_ACCESS: ['beach access', 'private beach', 'beachfront', 'beach front'],
  PETS_ALLOWED: ['pets allowed', 'pet friendly', 'pets welcome'],
  ROOM_SERVICE: ['room service', '24 hour room service'],
  KIDS_CLUB: ['kids club', 'childrens club', 'children club', 'kids play area'],
  BUSINESS_CENTER: ['business centre', 'business center', 'meeting rooms'],
  LAUNDRY: ['laundry', 'laundry service', 'dry cleaning'],
  ACCESSIBLE: ['wheelchair accessible', 'accessible', 'disabled access', 'step free access'],
}

const AMENITY_LOOKUP = new Map<string, AmenityCode>()
for (const [code, synonyms] of Object.entries(AMENITY_SYNONYMS) as Array<[AmenityCode, string[]]>) {
  for (const synonym of synonyms) AMENITY_LOOKUP.set(words(synonym), code)
}

export function normalizeAmenity(input: string | null | undefined): AmenityCode | null {
  return AMENITY_LOOKUP.get(words(input ?? '')) ?? null
}

export interface AmenityNormalization { codes: AmenityCode[]; unmapped: string[] }

/** Unmapped labels are returned, not dropped, so a vocabulary gap is visible to the reviewer. */
export function normalizeAmenities(inputs: ReadonlyArray<string | null | undefined>): AmenityNormalization {
  const codes = new Set<AmenityCode>()
  const unmapped = new Set<string>()
  for (const raw of inputs) {
    const label = (raw ?? '').trim()
    if (!label) continue
    const code = normalizeAmenity(label)
    if (code) codes.add(code)
    else unmapped.add(label)
  }
  return { codes: [...codes].sort(), unmapped: [...unmapped].sort() }
}

/**
 * Phone numbers compare as evidence only in international form. A national-form number can still match on its significant digits,
 * which is weaker evidence and reported as such ('national') so the caller can refuse to auto-map on it.
 */
export function normalizePhone(input: string | null | undefined): { international: boolean; digits: string } | null {
  const raw = (input ?? '').trim()
  if (!raw) return null
  const international = raw.startsWith('+') || raw.startsWith('00')
  const digits = raw.replace(/\D/g, '').replace(/^00/, '')
  if (digits.length < 7 || new Set(digits).size < 3) return null
  return { international, digits }
}

export type PhoneMatch = 'international' | 'national' | null

export function comparePhones(left: string | null | undefined, right: string | null | undefined): PhoneMatch {
  const a = normalizePhone(left)
  const b = normalizePhone(right)
  if (!a || !b) return null
  if (a.international && b.international) return a.digits === b.digits ? 'international' : null
  // A national number starts with a trunk prefix (04 399 8888) that the international form drops, so compare its significant
  // digits as a suffix. Fewer than eight significant digits is too short to be evidence.
  const significant = (phone: { digits: string }) => phone.digits.replace(/^0+/, '')
  const [national, other] = a.international ? [b, a] : [a, b]
  const tail = significant(national)
  if (tail.length < 8) return null
  return other.international ? (other.digits.endsWith(tail) ? 'national' : null) : (significant(other) === tail ? 'national' : null)
}

export function normalizePostalCode(input: string | null | undefined): string {
  const code = (input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return code.length >= 3 ? code : ''
}

/** Official registry, trade-licence or tax identifier. Compared exactly after case and punctuation folding. */
export function normalizeRegistryCode(input: string | null | undefined): string {
  const code = (input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return code.length >= 5 ? code : ''
}
