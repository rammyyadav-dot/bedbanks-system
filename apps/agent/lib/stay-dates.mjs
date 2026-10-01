const DAY = 86_400_000

export const SEARCH_BUSINESS_TIME_ZONE = 'Asia/Dubai'

export function utcToday(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10)
}

export function businessToday(now = Date.now(), timeZone = SEARCH_BUSINESS_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now))
  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value
  if (!year || !month || !day) return utcToday(now)
  return `${year}-${month}-${day}`
}

export function addUtcDays(value, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match || !Number.isInteger(days)) return null
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const date = new Date(time)
  if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) return null
  return new Date(time + days * DAY).toISOString().slice(0, 10)
}

export function defaultSearchStay(now = Date.now(), nights = 3) {
  const checkIn = businessToday(now)
  return { checkIn, checkOut: addUtcDays(checkIn, nights) ?? checkIn }
}
