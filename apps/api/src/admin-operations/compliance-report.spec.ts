import { createHash } from 'node:crypto'
import { COMPLIANCE_CATEGORY_VALUES, type ComplianceRecordView } from '@bedbanks/contracts'
import { buildComplianceReport, complianceReportCsv, recordsSha256 } from './compliance-report'

const record = (i: number, over: Partial<ComplianceRecordView> = {}): ComplianceRecordView => ({
  id: `rec-${i}`, occurredAt: `2026-10-0${i}T10:00:00.000Z`, category: 'ACCESS_DENIAL', action: 'permission.denied', entityType: 'admin_permission', entityId: 'finance.read',
  actorType: 'USER', userId: 'u1', payloadSha256: createHash('sha256').update(String(i)).digest('hex'), originCountry: null, destinationCountry: null, crossBorder: null,
  exportState: 'PENDING', batchSequence: null, storedAt: null, ...over,
})

describe('compliance report (ADR 0067 amendment 3)', () => {
  const records = [
    record(1, { exportState: 'STORED', batchSequence: 1, storedAt: '2026-10-02T00:00:00.000Z' }),
    record(2, { category: 'BOOKING_JURISDICTION', action: 'booking.confirmed', entityType: 'booking', originCountry: 'GB', destinationCountry: 'AE', crossBorder: true, exportState: 'SEALED', batchSequence: 2 }),
    record(3, { category: 'BOOKING_JURISDICTION', action: 'booking.confirmed', entityType: 'booking', originCountry: 'GB', destinationCountry: 'AE', crossBorder: true }),
    record(4, { category: 'BOOKING_JURISDICTION', action: 'booking.cancelled', entityType: 'booking', originCountry: 'AE', destinationCountry: 'AE', crossBorder: false }),
    record(5, { category: 'BOOKING_JURISDICTION', action: 'booking.cancelled', entityType: 'booking' }),
    record(6, { category: 'RBAC_CHANGE', action: '=HYPERLINK("http://x")', entityId: '+cmd' }),
  ]
  const report = buildComplianceReport({ tenantId: 't1', from: '2026-10-01', to: '2026-10-31', generatedAt: new Date('2026-11-01T00:00:00.000Z'), generatedByUserId: 'u9', records, chainHead: { sequence: 2, batchSha256: 'a'.repeat(64), storageStatus: 'SEALED', storedAt: null } })

  it('counts every category (zero included), per action, and the export coverage', () => {
    expect(report.byCategory.map((c) => c.category)).toEqual([...COMPLIANCE_CATEGORY_VALUES])
    expect(report.byCategory.find((c) => c.category === 'BOOKING_JURISDICTION')).toEqual({ category: 'BOOKING_JURISDICTION', count: 4, actions: [{ action: 'booking.cancelled', count: 2 }, { action: 'booking.confirmed', count: 2 }] })
    expect(report.byCategory.find((c) => c.category === 'DATA_EXPORT')).toEqual({ category: 'DATA_EXPORT', count: 0, actions: [] })
    expect(report.totals).toEqual({ records: 6, stored: 1, sealed: 1, pending: 4 })
  })

  it('splits bookings by jurisdiction and lists cross-border corridors', () => {
    expect(report.bookings).toEqual({ crossBorder: 2, domestic: 1, unknown: 1, corridors: [{ origin: 'GB', destination: 'AE', count: 2 }] })
  })

  it('attests the exact records with a hash anyone can recompute, and changes it when any record changes', () => {
    const expected = createHash('sha256').update(records.map((r) => `${r.id}\t${r.payloadSha256}\n`).join('')).digest('hex')
    expect(report.attestation).toEqual({ recordsSha256: expected, recordCount: 6, chainHead: { sequence: 2, batchSha256: 'a'.repeat(64), storageStatus: 'SEALED', storedAt: null } })
    expect(recordsSha256(records.slice(1))).not.toBe(expected)
    expect(recordsSha256([...records].reverse())).not.toBe(expected)
    expect(recordsSha256([])).toBe(createHash('sha256').digest('hex'))
  })

  it('renders a formula-safe CSV with the attestation in its header block and one row per record', () => {
    const csv = complianceReportCsv(report)
    expect(csv.startsWith('﻿')).toBe(true)
    const lines = csv.slice(1).trimEnd().split('\r\n')
    expect(lines).toContain(`Records SHA-256,${report.attestation.recordsSha256}`)
    expect(lines).toContain(`Chain head,#2 ${'a'.repeat(64)} (SEALED)`)
    const header = lines.findIndex((l) => l.startsWith('Occurred at (UTC),Record id'))
    expect(lines.length - header - 1).toBe(6)
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`)
    expect(csv).toContain(`,'+cmd,`)
    expect(csv).not.toMatch(/,=|,\+cmd/)
  })
})
