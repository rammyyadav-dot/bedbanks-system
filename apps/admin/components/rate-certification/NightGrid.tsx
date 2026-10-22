import type { RatePlanAuditDetail } from '@bedbanks/contracts'
import { Money } from '@/components/ops/ops-ui'
import { Chip, ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { reasonText } from '@/lib/hotel-ui'
import { rowClassTone } from '@/lib/rate-certification-ui'

/** Night-by-night stored rate with the evaluator's verdict for each night. Read-only: edits go through Quick Update. */
export function NightGrid({ detail }: { detail: Pick<RatePlanAuditDetail, 'calendar' | 'currency'> }) {
  return (
    <ScrollRegion label="Night by night">
      <table style={tableStyle} aria-label="Night by night" data-testid="calendar">
        <thead><tr>{['Night', 'Stored rate', 'Basis', 'Row class', 'Evaluator', 'Reasons'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
        <tbody>{detail.calendar.map((c) => (
          <tr key={c.date} data-sellable={String(c.sellable)}>
            <td style={td}>{c.date}</td>
            <td style={td}><Money minor={c.rateMinor} currency={detail.currency} /></td>
            <td style={td}>{c.basis ?? '—'}</td>
            <td style={td}>{c.rowClass ? <Chip tone={rowClassTone(c.rowClass)}>{c.rowClass.split('_').join(' ')}</Chip> : '—'}</td>
            <td style={td}><Chip tone={c.sellable ? 'ok' : 'neutral'}>{c.sellable ? 'SELLABLE' : 'NOT SELLABLE'}</Chip></td>
            <td style={td}>{c.reasons.length === 0 ? '—' : c.reasons.map((r) => <span key={r} title={reasonText(r)} style={{ marginRight: 6 }}><code>{r}</code></span>)}</td>
          </tr>))}</tbody>
      </table>
    </ScrollRegion>
  )
}
