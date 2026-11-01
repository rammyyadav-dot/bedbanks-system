'use client'

import type { CalendarPreview } from '@bedbanks/contracts'
import { formatMinorUnits } from '@/lib/minor-units'
import { Chip, ScrollRegion, td, th, tableStyle } from '../ui'

const describe = (kind: string, value: Record<string, unknown> | null): string => {
  if (!value) return 'New cell'
  if (kind === 'rate') return `${formatMinorUnits(String(value.amountMinor), String(value.currency))} · ${value.amountBasis === 'NET' ? 'Net' : value.amountBasis === 'SELL' ? 'Sell' : 'Unverified basis'}`
  return `${String(value.allotment)} rooms · ${value.stopSell ? 'Stop sell' : 'Open'} · min ${String(value.minStay)} nights`
}

/** The server's own preview of an atomic calendar edit: exact before and after for each cell. Shared by the grid and the import so a reviewer always sees the same thing. */
export function CalendarReview({ preview, planCode }: { preview: CalendarPreview; planCode: (ratePlanId: string) => string }) {
  return (
    <ScrollRegion label="Calendar changes to review" maxHeight={320}>
      <table style={tableStyle} aria-label="Calendar changes">
        <thead><tr>{['Plan', 'Night', 'Kind', 'Before', 'After'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
        <tbody>
          {preview.changes.map((c) => (
            <tr key={`${c.kind}:${c.ratePlanId}:${c.stayDate}`} data-testid="review-row">
              <td style={td}><code>{planCode(c.ratePlanId)}</code></td><td style={td}>{c.stayDate}</td><td style={td}><Chip tone="neutral">{c.kind}</Chip></td>
              <td style={td}>{describe(c.kind, c.before)}</td><td style={td}><strong>{describe(c.kind, c.after)}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  )
}
