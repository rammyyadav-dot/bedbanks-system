/** Local paint draft for Room Availability. Stock is never calculated here. */
export const PAINT_MODES = ['FREE_SALE', 'STOP_SALE', 'ON_REQUEST', 'LIMITED'] as const
export type PaintMode = (typeof PAINT_MODES)[number]
export const PAINT_WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const

export interface PaintCell { roomTypeId: string; stayDate: string; version: number | null }
export interface DraftCell extends PaintCell { mode: PaintMode; salesCap: number | null }

export interface PaintDraft {
  mode: PaintMode | null
  salesCap: string
  deadlineHours: string
  owner: string
  escalation: string
  reason: string
  confirmBroadReopen: boolean
  allRoomTypes: boolean
  roomTypeIds: string[]
  from: string
  to: string
  weekdays: string[]
  cells: DraftCell[]
  undo: DraftCell[][]
}

export const emptyPaint = (from: string, to: string): PaintDraft => ({
  mode: null, salesCap: '', deadlineHours: '24', owner: '', escalation: '', reason: '', confirmBroadReopen: false,
  allRoomTypes: true, roomTypeIds: [], from, to, weekdays: [], cells: [], undo: [],
})

const iso = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
const weekday = (date: string) => PAINT_WEEKDAYS[(new Date(`${date}T00:00:00.000Z`).getUTCDay() + 6) % 7]

export function inclusiveStayDates(from: string, to: string): string[] | null {
  if (!iso(from) || !iso(to) || from > to) return null
  const dates: string[] = []
  let cursor = from
  for (let i = 0; i < 62; i += 1) {
    dates.push(cursor)
    if (cursor === to) return dates
    cursor = new Date(Date.parse(`${cursor}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10)
  }
  return null
}

/** What still has to be entered before a stroke may change cells. Null means painting is allowed. */
export function paintBlockedReason(draft: PaintDraft): string | null {
  if (!draft.mode) return 'Choose a paint mode.'
  if (draft.mode === 'LIMITED') {
    const cap = Number(draft.salesCap)
    if (!Number.isInteger(cap) || cap < 1 || cap > 9999) return 'Limited needs a sales cap from 1 to 9999.'
  }
  if (draft.mode === 'ON_REQUEST') {
    const hours = Number(draft.deadlineHours)
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) return 'On Request needs a response deadline from 1 to 168 hours.'
    if (draft.owner.trim().length < 2) return 'On Request needs an owner.'
    if (draft.escalation.trim().length < 3) return 'On Request needs an escalation policy.'
  }
  return null
}

export function beginStroke(): Set<string> { return new Set() }

/** Assigns the selected mode. A cell entered twice in one stroke stays as the first assignment. */
export function paintStroke(draft: PaintDraft, targets: readonly PaintCell[], stroke: Set<string>): PaintDraft {
  if (paintBlockedReason(draft) || !draft.mode) return draft
  const cap = draft.mode === 'LIMITED' ? Number(draft.salesCap) : null
  let next = draft.cells
  let changed = false
  for (const target of targets) {
    const key = `${target.roomTypeId}|${target.stayDate}`
    if (stroke.has(key)) continue
    stroke.add(key)
    const previous = next.find((cell) => cell.roomTypeId === target.roomTypeId && cell.stayDate === target.stayDate)
    if (previous && previous.mode === draft.mode && previous.salesCap === cap) continue
    changed = true
    next = [...next.filter((cell) => !(cell.roomTypeId === target.roomTypeId && cell.stayDate === target.stayDate)), { ...target, mode: draft.mode, salesCap: cap }]
  }
  if (!changed) return draft
  return { ...draft, cells: next, undo: [...draft.undo, draft.cells] }
}

export function fillRange(draft: PaintDraft, rooms: readonly { id: string }[], known: readonly PaintCell[]): { draft: PaintDraft; error: string | null } {
  const blocked = paintBlockedReason(draft)
  if (blocked) return { draft, error: blocked }
  const dates = inclusiveStayDates(draft.from, draft.to)
  if (!dates) return { draft, error: 'Stay date from and stay date to are inclusive, and from must be on or before to.' }
  const selected = dates.filter((date) => draft.weekdays.length === 0 || draft.weekdays.includes(weekday(date)))
  const roomIds = draft.allRoomTypes ? rooms.map((room) => room.id) : draft.roomTypeIds
  if (roomIds.length === 0 || selected.length === 0) return { draft, error: 'Select at least one room type and one stay night.' }
  const targets = roomIds.flatMap((roomTypeId) => selected.map((stayDate) => known.find((cell) => cell.roomTypeId === roomTypeId && cell.stayDate === stayDate) ?? { roomTypeId, stayDate, version: null }))
  return { draft: paintStroke(draft, targets, beginStroke()), error: null }
}

export function undoPaint(draft: PaintDraft): PaintDraft {
  const previous = draft.undo[draft.undo.length - 1]
  if (!previous) return draft
  return { ...draft, cells: previous, undo: draft.undo.slice(0, -1) }
}

export function resetPaint(draft: PaintDraft): PaintDraft {
  return { ...draft, cells: [], undo: [] }
}

export function clearPaintMode(draft: PaintDraft): PaintDraft {
  return { ...draft, mode: null }
}
