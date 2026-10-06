'use client'

import { BOOKING_COLUMN_IDS, BOOKING_COLUMN_LABEL, BOOKING_COLUMNS_REQUIRED, DEFAULT_BOOKING_COLUMNS, moveColumn, toggleColumn, type BookingColumnId } from '@/lib/booking-ui'

/** Show, hide and reorder columns. The choice is kept in this browser only; saved views that follow a person arrive in Phase 6. */
export function ColumnPicker({ columns, onChange }: { columns: BookingColumnId[]; onChange: (next: BookingColumnId[]) => void }) {
  const hidden = BOOKING_COLUMN_IDS.filter((id) => !columns.includes(id))
  return (
    <details className="workspace-panel" style={{ padding: '8px 12px', fontSize: 11 }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Columns ({columns.length} of {BOOKING_COLUMN_IDS.length})</summary>
      <p style={{ color: '#3f565c', margin: '6px 0' }}>Kept in this browser. Booking # and Actions always show.</p>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4 }} aria-label="Shown columns">
        {columns.map((id) => (
          <li key={id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <label style={{ flex: 1, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked disabled={BOOKING_COLUMNS_REQUIRED.includes(id)} onChange={() => onChange(toggleColumn(columns, id))} />
              {BOOKING_COLUMN_LABEL[id]}
            </label>
            <button type="button" className="admin-btn" aria-label={`Move ${BOOKING_COLUMN_LABEL[id]} left`} disabled={BOOKING_COLUMNS_REQUIRED.includes(id)} onClick={() => onChange(moveColumn(columns, id, -1))}>←</button>
            <button type="button" className="admin-btn" aria-label={`Move ${BOOKING_COLUMN_LABEL[id]} right`} disabled={BOOKING_COLUMNS_REQUIRED.includes(id)} onClick={() => onChange(moveColumn(columns, id, 1))}>→</button>
          </li>
        ))}
        {hidden.map((id) => (
          <li key={id}><label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', color: '#3f565c' }}><input type="checkbox" checked={false} onChange={() => onChange(toggleColumn(columns, id))} />{BOOKING_COLUMN_LABEL[id]} (hidden)</label></li>
        ))}
      </ul>
      <button type="button" className="admin-btn" style={{ marginTop: 8 }} onClick={() => onChange([...DEFAULT_BOOKING_COLUMNS])}>Reset columns</button>
    </details>
  )
}
