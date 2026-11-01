import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BOOKING_EXPORT_MAX_ROWS, bookingExportColumns, bookingExportCsv, bookingExportFilename, bookingExportPermission, csvCell, formatMinorDecimal, permissionCatalogue,
  type BookingListRow,
} from '@bedbanks/contracts'

const row = (over: Partial<BookingListRow> = {}): BookingListRow => ({
  id: 'bk1', reference: 'FB-AAAA', status: 'CONFIRMED', supplierStatus: 'CONFIRMED', agency: { id: 'ag1', name: 'Atlas Getaways' }, agent: 'Sam Agent', supplier: 'Direct contract', supplierRef: 'SUP-1', hotelConfirmationNo: 'HC-9', agentRef: 'AG-1',
  channel: 'PORTAL', leadGuest: { name: 'A••• H•••', masked: true }, guests: { adults: 2, children: 1 }, hotel: { id: 'h1', name: 'Royal Ascot Hotel', city: 'Dubai', timeZone: 'Asia/Dubai' }, room: { name: 'Superior Deluxe', board: 'BB', quantity: 1 },
  checkIn: '2030-06-20', checkOut: '2030-06-22', nights: 2, createdAt: '2030-06-01T08:30:15.123Z', cancelDeadline: '2030-06-18T08:00:00.000Z', currency: 'AED', sellMinor: '73000', netMinor: '65000', marginMinor: '8000',
  paymentMode: 'CREDIT', paymentStatus: 'UNPAID', isRefundable: true, version: 1, closedAt: null, assignedTo: null, missingSupplierRef: false, amended: false, attention: null, ...over,
})

describe('booking export (ADR 0039, Phase 6D)', () => {
  it('EX-01: money is integer minor units rendered with the currency exponent, no floating point; an unknown currency is shown as minor units, never guessed', () => {
    expect(formatMinorDecimal('73000', 'AED')).toBe('730.00')
    expect(formatMinorDecimal('5', 'AED')).toBe('0.05')
    expect(formatMinorDecimal('0', 'USD')).toBe('0.00')
    expect(formatMinorDecimal('1500', 'JPY')).toBe('1500')
    expect(formatMinorDecimal('1234567', 'KWD')).toBe('1234.567')
    expect(formatMinorDecimal('-250', 'GBP')).toBe('-2.50')
    expect(formatMinorDecimal('99999999999999999', 'USD')).toBe('999999999999999.99')
    expect(formatMinorDecimal('1000', 'XYZ')).toBe('1000 (minor units)')
    expect(formatMinorDecimal('12.5', 'USD')).toBe('12.5 (minor units)')
  })

  it('EX-02: a cell a spreadsheet would run as a formula is neutralised; quotes, commas and line breaks are escaped', () => {
    for (const hostile of ['=HYPERLINK("http://evil","x")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\r=1+1', '  =1+1']) {
      const cell = csvCell(hostile)
      expect(cell.replace(/^"/, '').startsWith("'")).toBe(true)
    }
    expect(csvCell('Smith, John')).toBe('"Smith, John"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\nline2')).toBe('line1 line2')
    expect(csvCell(null)).toBe('')
    expect(csvCell(0)).toBe('0')
    expect(csvCell('plain')).toBe('plain')
  })

  it('EX-03: net and margin are columns only with booking.view.net, and the file never contains them otherwise', () => {
    const without = bookingExportColumns({ canViewNet: false }).map((c) => c.id)
    expect(without).not.toContain('net'); expect(without).not.toContain('margin')
    expect(bookingExportColumns({ canViewNet: true }).map((c) => c.id)).toEqual(expect.arrayContaining(['net', 'margin']))
    const plain = bookingExportCsv([row()], { canViewNet: false })
    expect(plain).not.toContain('65000'); expect(plain).not.toContain('650.00'); expect(plain).not.toContain('Margin')
    const withNet = bookingExportCsv([row()], { canViewNet: true })
    expect(withNet).toContain('650.00'); expect(withNet).toContain('80.00')
  })

  it('EX-04: the file carries the masked guest name it was given (the builder never un-masks) and states every column in a stable order', () => {
    const csv = bookingExportCsv([row()], { canViewNet: false })
    expect(csv.startsWith('﻿')).toBe(true)
    const [header, line] = csv.replace('﻿', '').split('\r\n')
    expect(header.split(',')[0]).toBe('Booking #')
    expect(line).toContain('A••• H•••')
    expect(line).toContain('730.00')
    expect(line).toContain('2030-06-01 08:30:15Z')
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(csv.split('\r\n').length).toBe(3)
  })

  it('EX-05: a hostile guest name or supplier reference is neutralised in the file', () => {
    const csv = bookingExportCsv([row({ supplierRef: '=cmd|\' /C calc\'!A0', leadGuest: { name: '@evil', masked: false } })], { canViewNet: false })
    expect(csv).toContain("'=cmd")
    expect(csv).toContain("'@evil")
  })

  it('EX-06: operators need booking.export and agency users booking.export.agency; the limit is 1,000 and the file is named by day', () => {
    expect(bookingExportPermission({ level: 'OPERATOR' })).toBe('booking.export')
    expect(bookingExportPermission({ level: 'AGENCY' })).toBe('booking.export.agency')
    expect(BOOKING_EXPORT_MAX_ROWS).toBe(1000)
    expect(bookingExportFilename(new Date('2030-06-10T23:59:59Z'))).toBe('bookings-2030-06-10.csv')
    const keys = permissionCatalogue.filter((p) => p.key.startsWith('booking.export'))
    expect(keys.map((k) => `${k.key}:${k.status}`).sort()).toEqual(['booking.export.agency:enforced', 'booking.export:enforced'])
  })

  it('EX-07: wiring. The route is declared before the :bookingId route, needs a formal export permission, the guard, and the service audits BEFORE returning the file', () => {
    const controller = readFileSync(join(__dirname, '../admin-operations/operations.controller.ts'), 'utf8')
    const exportAt = controller.indexOf("@Get('bookings/export')"); const idAt = controller.indexOf("@Get('bookings/:bookingId')")
    expect(exportAt).toBeGreaterThan(-1); expect(exportAt).toBeLessThan(idAt)
    expect(controller.slice(exportAt, exportAt + 1200)).toContain('@Res() res: Response')
    expect(controller.slice(exportAt, exportAt + 220)).toContain("@RequireBookingAction('booking.export', 'booking.export.agency') @UseGuards(BookingAccessGuard)")
    const service = readFileSync(join(__dirname, '../admin-operations/operations-bookings.service.ts'), 'utf8')
    const body = service.slice(service.indexOf('async exportCsv'), service.indexOf('private async names'))
    expect(body.indexOf("action: 'booking.exported'")).toBeGreaterThan(-1)
    expect(body.indexOf("action: 'booking.exported'")).toBeLessThan(body.indexOf('return { csv'))
    expect(body).toContain('BOOKING_EXPORT_MAX_ROWS + 1')
    expect(body).not.toMatch(/guestSearch|filter\.guest|appliedFilters:[^\n]*value/)
  })

  it('EX-08: the migration only adds the two permissions, granted to no role', () => {
    const sql = readFileSync(join(__dirname, '../../prisma/migrations/202611230001_booking_export_permissions/migration.sql'), 'utf8')
    const statements = sql.split('\n').filter((l) => !l.trim().startsWith('--') && l.trim() !== '').join(' ')
    expect(statements).toMatch(/^INSERT INTO "Permission"/)
    expect(statements).not.toMatch(/RolePermission|CREATE |ALTER |DROP /)
    expect(sql).toContain("'booking.export'"); expect(sql).toContain("'booking.export.agency'")
  })
})
