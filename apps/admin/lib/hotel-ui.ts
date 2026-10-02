import {
  COMMERCIAL_REASON_TEXT, type CommercialReadiness, type ContractState, type GateState, type HotelSection, type InventoryState, type IssueSeverity, type MappingState, type SupplyDataState,
} from '@bedbanks/contracts'

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral'

/** Display-only mappings of server-computed states to a tone and a label. Nothing here decides readiness. */
export const readinessTone = (s: CommercialReadiness): Tone => (s === 'READY' ? 'ok' : s === 'PARTIAL' ? 'warn' : 'bad')
export const mappingTone = (s: MappingState): Tone => (s === 'MAPPED' ? 'ok' : s === 'PENDING' ? 'warn' : 'bad')
export const contractTone = (s: ContractState): Tone => (s === 'ACTIVE' ? 'ok' : s === 'EXPIRING' || s === 'INACTIVE' ? 'warn' : 'bad')
export const ratesTone = (s: SupplyDataState): Tone => (s === 'OK' ? 'ok' : s === 'GAPS' ? 'bad' : 'neutral')
export const inventoryTone = (s: InventoryState): Tone => (s === 'OK' ? 'ok' : s === 'STOP_SELL' ? 'warn' : s === 'NONE' ? 'neutral' : 'bad')
export const severityTone = (s: IssueSeverity): Tone => (s === 'CRITICAL' ? 'bad' : s === 'HIGH' ? 'warn' : 'neutral')
export const gateTone = (s: GateState): Tone => (s === 'PASS' ? 'ok' : s === 'WARN' ? 'warn' : s === 'FAIL' ? 'bad' : 'neutral')

export const reasonText = (code: string): string => COMMERCIAL_REASON_TEXT[code] ?? code

export const HOTEL_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'rooms', label: 'Rooms' },
  { id: 'mappings', label: 'Mappings' },
  { id: 'contracts', label: 'Contracts' },
  { id: 'rates', label: 'Rates & Inventory' },
  { id: 'sellability', label: 'Sellability' },
  { id: 'bookings', label: 'Bookings' },
  { id: 'audit', label: 'Audit' },
] as const
export type HotelTabId = (typeof HOTEL_TABS)[number]['id']

/** Unknown or missing tab values fall back to Overview rather than rendering nothing. */
export function parseTab(value: string | null | undefined): HotelTabId {
  return (HOTEL_TABS.find((tab) => tab.id === value)?.id ?? 'overview') as HotelTabId
}
/** A section named by an issue maps one-to-one onto a tab, so every issue links to where it is resolved. */
export function sectionTab(section: HotelSection): HotelTabId { return section }
/** Optional context so a link lands on the affected record: the first affected night and the room. Only these two are ever carried. */
export interface HotelLinkContext { from?: string | null; roomTypeId?: string | null }
export function hotelHref(hotelId: string, tab: HotelTabId = 'overview', context: HotelLinkContext = {}): string {
  const query = new URLSearchParams()
  if (tab !== 'overview') query.set('tab', tab)
  if (context.from && /^\d{4}-\d{2}-\d{2}$/.test(context.from)) query.set('from', context.from)
  if (context.roomTypeId) query.set('roomTypeId', context.roomTypeId)
  const text = query.toString()
  return text ? `/hotels/${hotelId}?${text}` : `/hotels/${hotelId}`
}

export const LIST_FILTER_KEYS = ['search', 'destination', 'supplierId', 'contentStatus', 'readiness', 'mapping', 'contractState', 'issue', 'expiresWithinDays'] as const
export type ListFilterKey = (typeof LIST_FILTER_KEYS)[number]

/** Reads only known filters from a URL, so a pasted link cannot inject unknown parameters into the API call. */
export function readListQuery(search: URLSearchParams | { get(name: string): string | null }): { filters: Partial<Record<ListFilterKey, string>>; page: number } {
  const filters: Partial<Record<ListFilterKey, string>> = {}
  for (const key of LIST_FILTER_KEYS) { const value = search.get(key); if (value) filters[key] = value }
  const raw = Number(search.get('page') ?? '1')
  return { filters, page: Number.isInteger(raw) && raw >= 1 ? raw : 1 }
}
export function listHref(filters: Partial<Record<ListFilterKey, string>>, page = 1): string {
  const query = new URLSearchParams()
  for (const key of LIST_FILTER_KEYS) { const value = filters[key]; if (value) query.set(key, value) }
  if (page > 1) query.set('page', String(page))
  const text = query.toString()
  return text ? `/hotels?${text}` : '/hotels'
}

/** Stars as text, with a visible word for assistive technology and the no-rating case. */
export const starsText = (stars: number | null): string => (stars === null ? 'No rating' : `${stars} star${stars === 1 ? '' : 's'}`)
