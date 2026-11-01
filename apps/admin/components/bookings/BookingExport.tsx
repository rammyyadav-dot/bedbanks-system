'use client'

import { useState } from 'react'
import type { BookingAccessView, BookingListQuery } from '@bedbanks/contracts'
import { downloadBookingsCsv } from '@/lib/data/operations'
import { describeActionError } from '@/lib/booking-actions-ui'
import { canExport, exportBlockedReason, exportDoneNote, exportParams } from '@/lib/booking-export-ui'

/**
 * Excel / CSV and Print for the Bookings list (ADR 0039, Phase 6D). Export sends the current filters to the API, which checks the export permission, the caller's scope and the
 * row limit, masks and hides exactly what the list masks and hides, and writes an audit event before it returns the file. Print uses the browser's print dialog on the page as
 * shown (the current page of the list, or the board), laid out for A4 by the print stylesheet.
 */
export function BookingExport({ access, query, total, canPrint }: { access: BookingAccessView | null; query: BookingListQuery; total: number | null; canPrint: boolean }) {
  const [busy, setBusy] = useState(false); const [note, setNote] = useState<string | null>(null)
  const allowed = canExport(access)
  const blocked = allowed ? exportBlockedReason(query, total) : null
  async function run() {
    if (busy || !allowed || blocked) return
    setBusy(true); setNote(null)
    try {
      const { blob, headers, requestId } = await downloadBookingsCsv(exportParams(query))
      const name = /filename="([^"]+)"/.exec(headers.get('content-disposition') ?? '')?.[1] ?? 'bookings.csv'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
      setNote(exportDoneNote(headers.get('x-export-row-count'), requestId))
    } catch (error) { setNote(describeActionError(error).message) } finally { setBusy(false) }
  }
  return (
    <span className="no-print" style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11 }}>
      {allowed && <button type="button" className="admin-btn" data-testid="export-csv" disabled={busy || blocked !== null} aria-busy={busy} title={blocked ?? 'Download the filtered bookings as a CSV file that opens in Excel'} onClick={() => void run()}>{busy ? 'Exporting…' : 'Excel / CSV'}</button>}
      {canPrint && <button type="button" className="admin-btn" data-testid="print-bookings" onClick={() => window.print()}>Print</button>}
      {blocked && <span role="status" data-testid="export-blocked">{blocked}</span>}
      {note && <span role="status" data-testid="export-note">{note}</span>}
    </span>
  )
}
