import { createHash } from 'node:crypto'
import { COMPLIANCE_CATEGORY_VALUES, type ComplianceReport, type ComplianceRecordView } from '@bedbanks/contracts'
import { csvCell } from './hotel-export'

/**
 * The per-period compliance report (ADR 0067 amendment 3), built from records the caller already read (oldest first). Pure: no database, no clock.
 * The attestation hash covers exactly the listed records, so anyone holding the WORM archive can recompute it for the stored ones.
 */
export function recordsSha256(records: readonly Pick<ComplianceRecordView, 'id' | 'payloadSha256'>[]): string {
  const hash = createHash('sha256')
  for (const r of records) hash.update(`${r.id}\t${r.payloadSha256}\n`)
  return hash.digest('hex')
}

export function buildComplianceReport(input: {
  tenantId: string; from: string; to: string; generatedAt: Date; generatedByUserId: string
  records: ComplianceRecordView[]
  chainHead: ComplianceReport['attestation']['chainHead']
}): ComplianceReport {
  const { records } = input
  const byCategory = COMPLIANCE_CATEGORY_VALUES.map((category) => {
    const actions = new Map<string, number>()
    for (const r of records) if (r.category === category) actions.set(r.action, (actions.get(r.action) ?? 0) + 1)
    return {
      category, count: [...actions.values()].reduce((sum, n) => sum + n, 0),
      actions: [...actions].map(([action, count]) => ({ action, count })).sort((a, b) => b.count - a.count || a.action.localeCompare(b.action)),
    }
  })
  const bookings = records.filter((r) => r.category === 'BOOKING_JURISDICTION')
  const corridors = new Map<string, { origin: string; destination: string; count: number }>()
  for (const r of bookings) {
    if (r.crossBorder !== true || !r.originCountry || !r.destinationCountry) continue
    const key = `${r.originCountry}>${r.destinationCountry}`
    corridors.set(key, { origin: r.originCountry, destination: r.destinationCountry, count: (corridors.get(key)?.count ?? 0) + 1 })
  }
  const state = (s: ComplianceRecordView['exportState']) => records.filter((r) => r.exportState === s).length
  return {
    formatVersion: 1, tenantId: input.tenantId, period: { from: input.from, to: input.to }, generatedAt: input.generatedAt.toISOString(), generatedByUserId: input.generatedByUserId,
    definitions: {
      period: 'Inclusive UTC calendar days. A record belongs to the day its audit event was written.',
      byCategory: 'Compliance records captured by the database in the same transaction as their audit event, per category and action.',
      bookings: 'Booking confirmations, cancellations and manual bookings. Cross-border: the agency country differs from the hotel country. Unknown: either country is not recorded.',
      totals: 'Where each record is on its way to write-once storage: stored, in a sealed batch not yet stored, or not yet in a batch.',
      attestation: 'recordsSha256 is the SHA-256 of one line "<id>\\t<payloadSha256>\\n" per record, oldest first. Recompute it from the archived batches (ids and payloadSha256 of the stored records) to show this report matches the WORM archive. chainHead is the newest batch of this tenant\'s hash chain at generation time.',
      payload: 'Audit payloads are not included; each record carries the SHA-256 of its payload, which matches the archived copy.',
    },
    totals: { records: records.length, stored: state('STORED'), sealed: state('SEALED'), pending: state('PENDING') },
    byCategory,
    bookings: {
      crossBorder: bookings.filter((r) => r.crossBorder === true).length, domestic: bookings.filter((r) => r.crossBorder === false).length, unknown: bookings.filter((r) => r.crossBorder === null).length,
      corridors: [...corridors.values()].sort((a, b) => b.count - a.count || a.origin.localeCompare(b.origin) || a.destination.localeCompare(b.destination)),
    },
    attestation: { recordsSha256: recordsSha256(records), recordCount: records.length, chainHead: input.chainHead },
    records,
  }
}

const RECORD_COLUMNS: Array<[string, (r: ComplianceRecordView) => unknown]> = [
  ['Occurred at (UTC)', (r) => r.occurredAt], ['Record id', (r) => r.id], ['Category', (r) => r.category], ['Action', (r) => r.action], ['Entity type', (r) => r.entityType],
  ['Entity id', (r) => r.entityId], ['Actor type', (r) => r.actorType], ['User id', (r) => r.userId], ['Origin country', (r) => r.originCountry],
  ['Destination country', (r) => r.destinationCountry], ['Cross-border', (r) => (r.crossBorder === null ? 'unknown' : r.crossBorder ? 'yes' : 'no')],
  ['Export state', (r) => r.exportState], ['Batch', (r) => r.batchSequence], ['Stored at (UTC)', (r) => r.storedAt], ['Payload SHA-256', (r) => r.payloadSha256],
]

/** The same report as a spreadsheet: a header block with the period and the attestation, then one row per record. Formula-safe cells (csvCell). */
export function complianceReportCsv(report: ComplianceReport): string {
  const head = report.attestation.chainHead
  const rows: unknown[][] = [
    ['Compliance report', `format v${report.formatVersion}`], ['Tenant', report.tenantId], ['From', report.period.from], ['To', report.period.to],
    ['Generated at (UTC)', report.generatedAt], ['Generated by', report.generatedByUserId], ['Records', report.totals.records],
    ['Stored / sealed / pending', `${report.totals.stored} / ${report.totals.sealed} / ${report.totals.pending}`],
    ['Records SHA-256', report.attestation.recordsSha256],
    ['Chain head', head ? `#${head.sequence} ${head.batchSha256} (${head.storageStatus}${head.storedAt ? ` ${head.storedAt}` : ''})` : 'no batch yet'],
    [],
    RECORD_COLUMNS.map(([name]) => name),
    ...report.records.map((r) => RECORD_COLUMNS.map(([, get]) => get(r))),
  ]
  return '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
