/**
 * Smart Search (ADR 0065): deterministic extraction of search fields from a pasted client request.
 * Pure and transport-agnostic: no I/O, no clock (the caller passes the business date), no LLM. It never invents a value:
 * anything it cannot read is listed in `unresolved` and left to the agent.
 */

export const SMART_SEARCH_MAX_TEXT = 2000
export const SMART_SEARCH_MAX_NIGHTS = 30

export type SmartSearchField = 'destination' | 'dates' | 'occupancy' | 'stars' | 'nationality'

export interface SmartSearchRoom { adults: number; childAges: number[] }

export interface SmartSearchParse {
  /** Place or hotel text to resolve against the catalogue; never a resolved destination by itself. */
  destinationText?: string
  /** A nearby area the client asked for ("near Marina"). Areas are not searchable yet (ADR 0065), so this is reported, not applied. */
  nearText?: string
  checkIn?: string
  checkOut?: string
  nights?: number
  starRatings?: number[]
  rooms?: SmartSearchRoom[]
  /** ISO 3166-1 alpha-2, only for supported guest markets. */
  nationality?: string
  unresolved: SmartSearchField[]
  /** Human-readable reasons a value was found but not used (e.g. a past date). */
  notes: string[]
}

const WORD_NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, single: 1, two: 2, couple: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30 }
const NUM = '(\\d{1,2}|a|an|one|single|two|couple|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|fifteen|twenty|thirty)'
const MONTHS: Record<string, number> = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 }
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const WEEKDAYS: Record<string, number> = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 }
const WEEKDAY = '(sunday|sun|monday|mon|tuesday|tues?|wednesday|wed|thursday|thurs?|thu|friday|fri|saturday|sat)'

/** Supported guest markets (mirrors SUPPORTED_COUNTRIES in search-offers): [code, country names, demonyms], lower case. */
const MARKETS: Array<[string, string[], string[]]> = [
  ['AE', ['uae', 'united arab emirates'], ['emirati']], ['IN', ['india'], ['indian']], ['GB', ['uk', 'united kingdom', 'great britain', 'england'], ['british', 'english']],
  ['US', ['usa', 'united states'], ['american']], ['CA', ['canada'], ['canadian']], ['AU', ['australia'], ['australian']], ['SG', ['singapore'], ['singaporean']],
  ['SA', ['saudi arabia', 'ksa'], ['saudi']], ['QA', ['qatar'], ['qatari']], ['OM', ['oman'], ['omani']], ['KW', ['kuwait'], ['kuwaiti']], ['BH', ['bahrain'], ['bahraini']],
  ['DE', ['germany'], ['german']], ['FR', ['france'], ['french']], ['IT', ['italy'], ['italian']], ['ES', ['spain'], ['spanish']], ['NL', ['netherlands', 'holland'], ['dutch']],
  ['BE', ['belgium'], ['belgian']], ['CH', ['switzerland'], ['swiss']], ['AT', ['austria'], ['austrian']], ['IE', ['ireland'], ['irish']], ['PT', ['portugal'], ['portuguese']],
  ['GR', ['greece'], ['greek']], ['TR', ['turkey', 'turkiye'], ['turkish']], ['CN', ['china'], ['chinese']], ['JP', ['japan'], ['japanese']], ['KR', ['korea', 'south korea'], ['korean']],
  ['ID', ['indonesia'], ['indonesian']], ['MY', ['malaysia'], ['malaysian']], ['TH', ['thailand'], ['thai']], ['VN', ['vietnam'], ['vietnamese']], ['PH', ['philippines'], ['filipino']],
  ['ZA', ['south africa'], ['south african']], ['NZ', ['new zealand'], ['kiwi']],
]

/**
 * Reviewed query aliases (ADR 0065): multi-language names and common variants rewritten to the catalogue spelling before matching.
 * An alias only rewrites the query; results are always real catalogue cities or hotels.
 */
export const destinationAliases: Record<string, string> = {
  'دبي': 'Dubai', 'dubaï': 'Dubai', 'dubay': 'Dubai', 'dubái': 'Dubai', 'dubaj': 'Dubai', 'дубай': 'Dubai', '迪拜': 'Dubai',
  'أبوظبي': 'Abu Dhabi', 'abudhabi': 'Abu Dhabi', 'abu-dhabi': 'Abu Dhabi', 'الشارقة': 'Sharjah', 'sharja': 'Sharjah', 'ras al khaimah': 'Ras Al Khaimah', 'rak': 'Ras Al Khaimah',
  'bombay': 'Mumbai', 'calcutta': 'Kolkata', 'madras': 'Chennai', 'bangalore': 'Bengaluru', 'mecca': 'Makkah', 'medina': 'Madinah',
}

/** Applies the alias table to a whole query or to its leading words; returns the query unchanged when nothing matches. */
export function applyDestinationAlias(query: string): string {
  const folded = query.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
  if (destinationAliases[folded]) return destinationAliases[folded]
  for (const [alias, name] of Object.entries(destinationAliases)) {
    if (folded.startsWith(`${alias} `)) return `${name}${query.trim().slice(alias.length)}`
  }
  return query.trim()
}

/** The calendar date in a time zone, as YYYY-MM-DD. */
export function businessDate(now: Date, timeZone = 'Asia/Dubai'): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

const DAY = 86_400_000
const toUtc = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`)
const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const addDays = (iso: string, days: number) => toIso(toUtc(iso) + days * DAY)
function validDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return null
  const ms = Date.UTC(year, month - 1, day)
  const d = new Date(ms)
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? toIso(ms) : null
}
/** A day and month without a year: the next occurrence on or after today. */
function upcoming(today: string, month: number, day: number): string | null {
  const year = Number(today.slice(0, 4))
  const candidate = validDate(year, month, day)
  if (candidate && candidate >= today) return candidate
  return validDate(year + 1, month, day)
}
function count(word: string | undefined): number | null {
  if (!word) return null
  const n = /^\d+$/.test(word) ? Number(word) : WORD_NUMBERS[word.toLowerCase()]
  return Number.isSafeInteger(n) ? n : null
}

type DateHit = { iso: string; index: number }

function findDates(text: string, today: string): DateHit[] {
  const hits: DateHit[] = []
  const push = (iso: string | null, index: number) => { if (iso) hits.push({ iso, index }) }
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) push(validDate(Number(m[1]), Number(m[2]), Number(m[3])), m.index ?? 0)
  // Day-first numeric dates (UAE/India convention): 23/10, 23.10.2026, 23-10-26.
  for (const m of text.matchAll(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/g)) {
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null
    push(year ? validDate(year, Number(m[2]), Number(m[1])) : upcoming(today, Number(m[2]), Number(m[1])), m.index ?? 0)
  }
  const dayMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH}\\.?(?:,?\\s+(\\d{4}))?\\b`, 'gi')
  for (const m of text.matchAll(dayMonth)) push(m[3] ? validDate(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1])) : upcoming(today, MONTHS[m[2].toLowerCase()], Number(m[1])), m.index ?? 0)
  const monthDay = new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi')
  for (const m of text.matchAll(monthDay)) push(m[3] ? validDate(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2])) : upcoming(today, MONTHS[m[1].toLowerCase()], Number(m[2])), m.index ?? 0)
  for (const m of text.matchAll(/\b(today|tonight)\b/gi)) push(today, m.index ?? 0)
  for (const m of text.matchAll(/\btomorrow\b/gi)) push(addDays(today, 1), m.index ?? 0)
  for (const m of text.matchAll(new RegExp(`\\bin\\s+${NUM}\\s+days?\\b`, 'gi'))) { const n = count(m[1]); if (n !== null) push(addDays(today, n), m.index ?? 0) }
  for (const m of text.matchAll(new RegExp(`\\b(next|this|coming|on)\\s+${WEEKDAY}\\b`, 'gi'))) {
    const target = WEEKDAYS[m[2].toLowerCase()]
    const current = new Date(toUtc(today)).getUTCDay()
    let ahead = (target - current + 7) % 7
    // "next Friday" said on a Thursday is tomorrow; said on a Friday it is a week away. "this/on Friday" on a Friday is today.
    if (ahead === 0 && m[1].toLowerCase() === 'next') ahead = 7
    push(addDays(today, ahead), m.index ?? 0)
  }
  for (const m of text.matchAll(/\bnext\s+week(?:end)?\b/gi)) {
    const current = new Date(toUtc(today)).getUTCDay()
    const weekend = /end$/i.test(m[0])
    const target = weekend ? 5 : 1
    push(addDays(today, ((target - current + 7) % 7) || 7), m.index ?? 0)
  }
  // Keep the first hit at each position (the most specific pattern above wins), then text order.
  const byIndex = new Map<number, DateHit>()
  for (const hit of hits) if (!byIndex.has(hit.index)) byIndex.set(hit.index, hit)
  return [...byIndex.values()].sort((a, b) => a.index - b.index)
}

const STOP = new RegExp(`\\s+(?:near|close to|around|for|from|on|with|between|during|check|arriving|departing|staying|${NUM}\\s+(?:adults?|nights?|rooms?|pax|people|persons?|guests?|child|children|kids?)|\\d)\\b`, 'i')

function destinationFrom(text: string): { destination?: string; near?: string } {
  const out: { destination?: string; near?: string } = {}
  const near = text.match(/\b(?:near|close to|around)\s+(?:the\s+)?([A-Za-z][\w' -]{1,60}?)(?=\s+(?:for|from|on|with|\d)|[,.;!?\n]|$)/i)
  if (near) out.near = near[1].trim()
  const place = text.match(/\b(?:in|at|to)\s+((?:[A-ZÀ-ɏ؀-ۿ][\wÀ-ɏ؀-ۿ'&.-]*\s?){1,6})/u)
  if (place) {
    const raw = place[1].split(STOP)[0].replace(/[,.;:!?]+$/, '').trim()
    if (raw && !/^(?:the|a|an)$/i.test(raw) && !MONTHS[raw.toLowerCase()] && WEEKDAYS[raw.toLowerCase()] === undefined) out.destination = raw
  }
  if (!out.destination) {
    // A known alias anywhere in the text (any script), e.g. "فندق في دبي" ("a hotel in Dubai").
    const words = ` ${text.toLocaleLowerCase('en-US').replace(/[,.;:!?()]/g, ' ').replace(/\s+/g, ' ')} `
    const alias = Object.keys(destinationAliases).find((key) => words.includes(` ${key} `))
    if (alias) out.destination = destinationAliases[alias]
  }
  if (!out.destination) {
    // Arabic "في <place>" ("in <place>").
    const arabic = text.match(/(?:^|\s)في\s+([؀-ۿ]{2,}(?:\s[؀-ۿ]{2,})?)/u)
    if (arabic) out.destination = arabic[1]
  }
  return out
}

function occupancyFrom(text: string): { rooms?: SmartSearchRoom[]; issue?: string } {
  const lower = text.toLowerCase()
  const adultsMatch = lower.match(new RegExp(`\\b${NUM}\\s+(?:adults?|pax|persons?|people|guests?|travell?ers?)\\b`))
  const childrenMatch = lower.match(new RegExp(`\\b${NUM}\\s+(?:child|children|kids?|infants?)\\b`))
  const roomsMatch = lower.match(new RegExp(`\\b${NUM}\\s+(?:(?:double|twin|single|triple|family|standard|deluxe)\\s+)?rooms?\\b`))
  const couple = /\b(?:a\s+)?couple\b/.test(lower) && !adultsMatch
  let adults = count(adultsMatch?.[1]) ?? (couple ? 2 : null)
  const children = count(childrenMatch?.[1]) ?? 0
  const rooms = count(roomsMatch?.[1]) ?? 1
  if (adults === null && !childrenMatch && !roomsMatch) return {}
  const ages: number[] = []
  const agesMatch = lower.match(/\b(?:aged?|ages?)\s*(?:of\s*)?(\d{1,2}(?:\s*(?:,|and|&)\s*\d{1,2})*)/)
  if (agesMatch) for (const a of agesMatch[1].split(/\s*(?:,|and|&)\s*/)) ages.push(Number(a))
  for (const m of lower.matchAll(/\b(\d{1,2})\s*(?:yrs?|years?)(?:\s*old)?\b/g)) if (!agesMatch) ages.push(Number(m[1]))
  if (adults === null) return { issue: 'The number of adults was not stated.' }
  if (rooms < 1 || rooms > 8 || adults < rooms || adults > 4 * rooms) return { issue: `${adults} adults in ${rooms} room(s) is not a supported occupancy.` }
  if (children > 0 && (ages.length !== children || ages.some((age) => !Number.isInteger(age) || age < 0 || age > 17))) return { issue: `Every child needs an age from 0 to 17 (found ${ages.length} for ${children}).` }
  // Spread adults and children across rooms as evenly as possible; the agent can edit each room afterwards.
  const out: SmartSearchRoom[] = Array.from({ length: rooms }, () => ({ adults: 0, childAges: [] }))
  for (let i = 0; i < adults; i++) out[i % rooms].adults += 1
  ages.slice(0, children).forEach((age, i) => out[i % rooms].childAges.push(age))
  return { rooms: out }
}

function nationalityFrom(text: string): string | undefined {
  const lower = ` ${text.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ')} `
  const keyed = lower.match(/\b(?:nationality|passports?|citizens?|guests? from|residents? of|holders?)\s*(?:is|of|:)?\s*([a-z ]{2,30})/)
  for (const [code, countries, demonyms] of MARKETS) {
    // With a "nationality/passport" cue the country name counts; otherwise only a demonym does ("Indian guests"),
    // so a destination country ("a hotel in the UAE") is never read as the guests' nationality.
    if (keyed && [...countries, ...demonyms].some((name) => ` ${keyed[1]} `.includes(` ${name} `))) return code
  }
  for (const [code, , demonyms] of MARKETS) if (demonyms.some((name) => lower.includes(` ${name} `))) return code
  return undefined
}

export function parseSmartSearch(input: string, today: string): SmartSearchParse {
  const text = input.slice(0, SMART_SEARCH_MAX_TEXT).replace(/\s+/g, ' ').trim()
  const result: SmartSearchParse = { unresolved: [], notes: [] }
  if (!text) { result.unresolved = ['destination', 'dates', 'occupancy', 'stars', 'nationality']; return result }

  const place = destinationFrom(text)
  if (place.destination) result.destinationText = applyDestinationAlias(place.destination)
  if (place.near) { result.nearText = place.near; result.notes.push(`"near ${place.near}" is not applied: area search is not available yet.`) }

  const nightsMatch = text.match(new RegExp(`\\b${NUM}\\s+nights?\\b`, 'i'))
  const nights = count(nightsMatch?.[1]) ?? null
  const dates = findDates(text, today)
  let checkIn: string | undefined = dates[0]?.iso
  let checkOut: string | undefined = dates.find((d) => d.iso > (checkIn ?? ''))?.iso
  if (checkIn && nights !== null && (!checkOut || dates.length < 2)) checkOut = addDays(checkIn, nights)
  if (checkIn && checkIn < today) { result.notes.push(`Check-in ${checkIn} is in the past.`); checkIn = undefined; checkOut = undefined }
  if (checkIn && checkOut) {
    const stay = Math.round((toUtc(checkOut) - toUtc(checkIn)) / DAY)
    if (stay < 1 || stay > SMART_SEARCH_MAX_NIGHTS) { result.notes.push(`A stay of ${stay} nights is outside 1 to ${SMART_SEARCH_MAX_NIGHTS}.`); checkIn = undefined; checkOut = undefined }
    else { result.checkIn = checkIn; result.checkOut = checkOut; result.nights = stay }
  } else if (checkIn) result.notes.push('A check-in date was found but no check-out date or number of nights.')

  const stars = new Set<number>()
  const starWords: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 }
  for (const m of text.matchAll(/\b([1-5]|one|two|three|four|five)\s*(?:-|\s)?\s*(?:stars?|\*|★)(?:\s*(?:\+|or (?:above|more|better)))?/gi)) {
    const value = /^\d$/.test(m[1]) ? Number(m[1]) : starWords[m[1].toLowerCase()]
    if (/\+|above|more|better/i.test(m[0])) for (let s = value; s <= 5; s++) stars.add(s)
    else stars.add(value)
  }
  if (stars.size) result.starRatings = [...stars].sort((a, b) => a - b)

  const occupancy = occupancyFrom(text)
  if (occupancy.rooms) result.rooms = occupancy.rooms
  if (occupancy.issue) result.notes.push(occupancy.issue)

  const nationality = nationalityFrom(text)
  if (nationality) result.nationality = nationality

  if (!result.destinationText) result.unresolved.push('destination')
  if (!result.checkIn) result.unresolved.push('dates')
  if (!result.rooms) result.unresolved.push('occupancy')
  if (!result.starRatings) result.unresolved.push('stars')
  if (!result.nationality) result.unresolved.push('nationality')
  return result
}
