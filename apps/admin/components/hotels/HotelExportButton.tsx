'use client'

import { useState } from 'react'
import { downloadHotelsCsv } from '@/lib/data/hotel-commercial'
import { describeActionError } from '@/lib/booking-actions-ui'
import type { ListFilterKey } from '@/lib/hotel-ui'

/** Downloads the current filtered directory. The API enforces supply.hotels.export, caps the rows, and audits every download. */
export function HotelExportButton({ filters }: { filters: Partial<Record<ListFilterKey, string>> }) {
  const [busy, setBusy] = useState(false); const [note, setNote] = useState<string | null>(null)
  async function run() {
    if (busy) return
    setBusy(true); setNote(null)
    try {
      const { blob, headers, requestId } = await downloadHotelsCsv(filters)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = 'hotels.csv'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
      const truncated = headers.get('x-export-truncated') === 'true'
      setNote(`Exported ${headers.get('x-export-rows') ?? '?'} hotels${truncated ? ' (INCOMPLETE: the result was larger than the export limit or scan cap; narrow the filters)' : ''}.${requestId ? ` Request ${requestId}.` : ''}`)
    } catch (error) { setNote(describeActionError(error).message) } finally { setBusy(false) }
  }
  return <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 11 }}><button type="button" className="admin-btn" disabled={busy} aria-busy={busy} onClick={() => void run()}>{busy ? 'Exporting…' : 'Export CSV'}</button>{note && <span role="status">{note}</span>}</span>
}
