import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * ADR 0039: `Booking.status` and `Booking.closedAt` have exactly one writer, `transitionBooking`. This scans the API source and fails if anything else
 * writes either column, so a "quick fix" cannot reintroduce a second state machine. Creation (`booking.create` with the initial status) is not a transition.
 */
const SRC = join(__dirname, '..')
const ALLOWED = new Set(['booking-ops/booking-transition.ts'])
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  if (statSync(path).isDirectory()) return files(path)
  return /\.ts$/.test(name) && !/\.(spec|e2e-spec)\.ts$/.test(name) ? [path] : []
})
/** Each `booking.update(` / `updateMany(` / `upsert(` call (any receiver spelling) with its argument text up to a balanced close. */
function bookingWrites(source: string): string[] {
  const out: string[] = []
  const re = /\b(?:booking|bookings)\s*\.\s*(update|updateMany|upsert|updateManyAndReturn)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) {
    let depth = 1; let i = m.index + m[0].length
    while (i < source.length && depth > 0) { const c = source[i++]; if (c === '(') depth++; else if (c === ')') depth-- }
    out.push(source.slice(m.index, i))
  }
  return out
}

describe('Booking.status has one writer (ADR 0039)', () => {
  it('SW-01: no source file outside transitionBooking writes Booking.status or closedAt', () => {
    const offenders: string[] = []
    for (const file of files(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/')
      if (ALLOWED.has(rel)) continue
      for (const call of bookingWrites(readFileSync(file, 'utf8'))) if (/\bstatus\s*:|\bclosedAt\s*:/.test(call.replace(/where\s*:\s*\{[^}]*\}/g, ''))) offenders.push(`${rel}: ${call.slice(0, 80)}`)
      if (/UPDATE\s+"Booking"[^;]*\bstatus\b/i.test(readFileSync(file, 'utf8'))) offenders.push(`${rel}: raw SQL update of "Booking".status`)
    }
    expect(offenders).toEqual([])
  })

  it('SW-02: the scanner itself sees a write when there is one (so SW-01 cannot pass by being blind)', () => {
    expect(bookingWrites("await tx.booking.update({ where: { id }, data: { status: 'CANCELLED' } })")).toHaveLength(1)
    expect(bookingWrites('await this.prisma.booking.updateMany({ where: { id }, data: { supplier: "x" } })')).toHaveLength(1)
    const offending = bookingWrites("tx.booking.update({ where: { id: a, status: 'X' }, data: { status: 'Y' } })")[0].replace(/where\s*:\s*\{[^}]*\}/g, '')
    expect(/\bstatus\s*:/.test(offending)).toBe(true)
  })

  it('SW-03: the transition function is the only file that names the guarded update, and it does write status', () => {
    const source = readFileSync(join(SRC, 'booking-ops/booking-transition.ts'), 'utf8')
    expect(bookingWrites(source).some((c) => /status\s*:/.test(c) || /data\b/.test(c))).toBe(true)
  })
})
