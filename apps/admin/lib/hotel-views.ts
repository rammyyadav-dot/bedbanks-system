import { LIST_FILTER_KEYS, type ListFilterKey } from './hotel-ui'

/**
 * Personal Hotels filter presets, kept in this browser only. A preset stores nothing but known filter keys and values;
 * choosing one navigates to the normal list URL, so the API validates and authorizes the query exactly as it always does.
 * It never widens what the person may see, and it is not shared across devices or people.
 */
export const HOTEL_VIEWS_KEY = 'fbeds.admin.hotels.views.v1'
export const HOTEL_VIEW_NAME_MAX = 60
export const HOTEL_VIEW_LIMIT = 20

export interface HotelView { name: string; filters: Partial<Record<ListFilterKey, string>> }
export interface ViewStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

const clean = (raw: unknown): Partial<Record<ListFilterKey, string>> => {
  const out: Partial<Record<ListFilterKey, string>> = {}
  if (raw && typeof raw === 'object') for (const key of LIST_FILTER_KEYS) { const v = (raw as Record<string, unknown>)[key]; if (typeof v === 'string' && v && v.length <= 64) out[key] = v }
  return out
}

/** Corrupt, foreign or unavailable storage yields no views rather than an error. */
export function loadHotelViews(storage: ViewStorage | null): HotelView[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(HOTEL_VIEWS_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((v): HotelView[] => (v && typeof v.name === 'string' && v.name.trim() ? [{ name: v.name.trim().slice(0, HOTEL_VIEW_NAME_MAX), filters: clean(v.filters) }] : [])).slice(0, HOTEL_VIEW_LIMIT)
  } catch { return [] }
}

export type SaveResult = { ok: true; views: HotelView[] } | { ok: false; reason: string }

/** Saves (or replaces by name) the current filters. Refuses an empty name, an empty filter set, and a full list. */
export function saveHotelView(storage: ViewStorage | null, name: string, filters: Partial<Record<ListFilterKey, string>>): SaveResult {
  const trimmed = name.trim().slice(0, HOTEL_VIEW_NAME_MAX)
  const cleaned = clean(filters)
  if (!trimmed) return { ok: false, reason: 'A name is required.' }
  if (Object.keys(cleaned).length === 0) return { ok: false, reason: 'Apply at least one filter before saving a view.' }
  const existing = loadHotelViews(storage)
  const replaced = existing.some((v) => v.name === trimmed)
  if (!replaced && existing.length >= HOTEL_VIEW_LIMIT) return { ok: false, reason: `At most ${HOTEL_VIEW_LIMIT} views can be saved.` }
  const views = replaced ? existing.map((v) => (v.name === trimmed ? { name: trimmed, filters: cleaned } : v)) : [...existing, { name: trimmed, filters: cleaned }]
  return persist(storage, views)
}

export function deleteHotelView(storage: ViewStorage | null, name: string): SaveResult {
  return persist(storage, loadHotelViews(storage).filter((v) => v.name !== name))
}

function persist(storage: ViewStorage | null, views: HotelView[]): SaveResult {
  if (!storage) return { ok: false, reason: 'Saved views need browser storage, which is unavailable here.' }
  try { storage.setItem(HOTEL_VIEWS_KEY, JSON.stringify(views)); return { ok: true, views } } catch { return { ok: false, reason: 'The view could not be saved in this browser.' } }
}
