export const MAX_ROOMS = 8
export const MAX_OCCUPANTS = 40

export function clampCount(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

export function occupancySummary(rooms: number, adults: number, children: number) {
  const room = `${rooms} Room${rooms === 1 ? '' : 's'}`
  const adult = `${adults} Adult${adults === 1 ? '' : 's'}`
  const child = `${children} ${children === 1 ? 'Child' : 'Children'}`
  return `${room} · ${adult} · ${child}`
}

export function occupancyCompact(rooms: number, adults: number, children: number) {
  return `${rooms}R · ${adults}A${children ? ` · ${children}C` : ''}`
}

export type DraftChildAge = number | null

export const MAX_ADULTS_PER_ROOM = 8
export const MAX_CHILDREN_PER_ROOM = 6

export type RoomStayDraft = { adults: number; childAges: DraftChildAge[] }

export function defaultRoomStay(): RoomStayDraft {
  return { adults: 2, childAges: [] }
}

/** Builds the search occupancy snapshot. Uniform rooms keep per-room adults; mixed rooms keep each stay and a summed aggregate. */
export function buildRoomStays(stays: RoomStayDraft[]): { ok: true; rooms: number; adults: number; children: number; childAges: number[]; roomStays: { adults: number; children: { age: number }[] }[] } | { ok: false; reason: string } {
  if (!Array.isArray(stays) || stays.length < 1 || stays.length > MAX_ROOMS) return { ok: false, reason: 'Choose between 1 and 8 rooms.' }
  const roomStays: { adults: number; children: { age: number }[] }[] = []
  for (const [index, stay] of stays.entries()) {
    if (!Number.isInteger(stay.adults) || stay.adults < 1 || stay.adults > MAX_ADULTS_PER_ROOM) return { ok: false, reason: `Room ${index + 1} needs between 1 and ${MAX_ADULTS_PER_ROOM} adults.` }
    if (stay.childAges.length > MAX_CHILDREN_PER_ROOM) return { ok: false, reason: `Room ${index + 1} can include at most ${MAX_CHILDREN_PER_ROOM} children.` }
    const ages = resolvedChildAges(stay.childAges.length, stay.childAges)
    if (!ages) return { ok: false, reason: `Choose an age for each child in room ${index + 1}.` }
    roomStays.push({ adults: stay.adults, children: ages.map((age) => ({ age })) })
  }
  const first = roomStays[0]
  const uniform = roomStays.every((stay) => stay.adults === first.adults && stay.children.length === first.children.length && stay.children.every((child, index) => child.age === first.children[index].age))
  const adults = uniform ? first.adults : roomStays.reduce((sum, stay) => sum + stay.adults, 0)
  const childAges = uniform ? first.children.map((child) => child.age) : roomStays.flatMap((stay) => stay.children.map((child) => child.age))
  if (adults > MAX_OCCUPANTS || childAges.length > MAX_OCCUPANTS) return { ok: false, reason: 'Occupancy exceeds the search limit.' }
  return { ok: true, rooms: roomStays.length, adults, children: childAges.length, childAges, roomStays }
}

export function roomStaySummary(stays: RoomStayDraft[]): string {
  const rooms = stays.length
  const adults = stays.reduce((sum, stay) => sum + stay.adults, 0)
  const children = stays.reduce((sum, stay) => sum + stay.childAges.length, 0)
  return occupancySummary(rooms, adults, children)
}

/** Ages are unresolved until the agent picks one. Zero is a chosen infant age, not a default. */
export function resolvedChildAges(children: number, childAges: DraftChildAge[]): number[] | null {
  if (!Number.isInteger(children) || children < 0 || childAges.length !== children) return null
  if (childAges.some((age) => !Number.isInteger(age) || (age as number) < 0 || (age as number) > 17)) return null
  return childAges as number[]
}
