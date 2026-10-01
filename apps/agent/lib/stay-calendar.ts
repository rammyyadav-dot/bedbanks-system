const DAY = 86_400_000

export function utcToday(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

function parse(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const date = new Date(time)
  if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) return null
  return time
}

export function addUtcDays(value: string, days: number): string | null {
  const time = parse(value)
  if (time === null || !Number.isInteger(days)) return null
  return new Date(time + days * DAY).toISOString().slice(0, 10)
}

export function nightCount(checkIn: string, checkOut: string): number | null {
  const start = parse(checkIn)
  const end = parse(checkOut)
  if (start === null || end === null || end <= start) return null
  return Math.round((end - start) / DAY)
}

export function monthLabel(year: number, monthIndex: number): string {
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(year, monthIndex, 1))
}

export function shiftMonth(year: number, monthIndex: number, delta: number): { year: number; monthIndex: number } {
  const date = new Date(Date.UTC(year, monthIndex + delta, 1))
  return { year: date.getUTCFullYear(), monthIndex: date.getUTCMonth() }
}

/** Monday-first grid covering the month, including leading and trailing days. */
export function monthGrid(year: number, monthIndex: number): Array<{ iso: string; inMonth: boolean }> {
  const first = Date.UTC(year, monthIndex, 1)
  const lead = (new Date(first).getUTCDay() + 6) % 7
  const days = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
  const cells = Math.ceil((lead + days) / 7) * 7
  return Array.from({ length: cells }, (_, index) => {
    const iso = new Date(first + (index - lead) * DAY).toISOString().slice(0, 10)
    const parsed = parse(iso)
    const inMonth = parsed !== null && new Date(parsed).getUTCMonth() === monthIndex
    return { iso, inMonth }
  })
}

export function applyStayPick(
  stay: { checkIn: string; checkOut: string },
  picked: string,
  selecting: 'check-in' | 'check-out',
  now = Date.now(),
): { checkIn: string; checkOut: string; selecting: 'check-in' | 'check-out' } | null {
  const today = utcToday(now)
  if (!parse(picked) || picked < today) return null
  if (selecting === 'check-in') {
    const nights = nightCount(picked, stay.checkOut)
    const checkOut = nights !== null && nights <= 30 ? stay.checkOut : addUtcDays(picked, 1) ?? stay.checkOut
    return { checkIn: picked, checkOut, selecting: 'check-out' }
  }
  const nights = nightCount(stay.checkIn, picked)
  if (nights === null || nights > 30) return null
  return { checkIn: stay.checkIn, checkOut: picked, selecting: 'check-in' }
}
