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

/** Ages are unresolved until the agent picks one. Zero is a chosen infant age, not a default. */
export function resolvedChildAges(children: number, childAges: DraftChildAge[]): number[] | null {
  if (!Number.isInteger(children) || children < 0 || childAges.length !== children) return null
  if (childAges.some((age) => !Number.isInteger(age) || (age as number) < 0 || (age as number) > 17)) return null
  return childAges as number[]
}
