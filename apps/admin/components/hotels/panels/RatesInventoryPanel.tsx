'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import type { HotelCommercial360 } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money, Tag } from '@/components/ops/ops-ui'
import { getHotelCalendar } from '@/lib/data/hotel-commercial'
import { reasonText } from '@/lib/hotel-ui'
import { Chip, ScrollRegion, td, th, tableStyle } from '../ui'

const DAY_OPTIONS = [7, 14, 30, 62]
const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)

/** Rate, allotment, sold, held, remaining, stop-sell and the canonical verdict per plan and night. Nothing is calculated here: remaining and verdicts come from the API. */
export function RatesInventoryPanel({ hotelId, rooms }: { hotelId: string; rooms: HotelCommercial360['rooms'] }) {
  // A link from an issue opens the calendar at the first affected night and room.
  const linked = useSearchParams()
  const [from, setFrom] = useState(() => (isDay(linked.get('from') ?? '') ? (linked.get('from') as string) : ''))
  const [days, setDays] = useState(14)
  const [roomTypeId, setRoomTypeId] = useState(() => (rooms.some((r) => r.id === linked.get('roomTypeId')) ? (linked.get('roomTypeId') as string) : ''))
  const params = { from: isDay(from) ? from : undefined, days, roomTypeId: roomTypeId || undefined }
  const { state, reload } = useOpsQuery(() => getHotelCalendar(hotelId, params), [hotelId, params.from, days, roomTypeId])
  return (
    <div className="workspace-panel" style={{ padding: 18 }}>
      <form aria-label="Calendar controls" onSubmit={(event) => event.preventDefault()} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', marginBottom: 12 }}>
        <label style={{ display: 'grid', gap: 2, fontSize: 11 }}><span>From (blank = today)</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label style={{ display: 'grid', gap: 2, fontSize: 11 }}><span>Nights</span><select value={days} onChange={(event) => setDays(Number(event.target.value))}>{DAY_OPTIONS.map((d) => <option key={d} value={d}>{d}</option>)}</select></label>
        <label style={{ display: 'grid', gap: 2, fontSize: 11 }}><span>Room</span><select value={roomTypeId} onChange={(event) => setRoomTypeId(event.target.value)}><option value="">All rooms</option>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      </form>
      <OpsState state={state} onRetry={reload} isEmpty={(d) => d.rows.length === 0} empty={{ title: 'No rate plans', description: 'This hotel has no rate plan, so there is no rate or inventory to show.' }}>
        {(data) => (
          <div data-testid="calendar">
            <p style={{ color: '#3f565c', fontSize: 11, marginTop: 0 }}>{data.window.from} → {data.window.to} · remaining = allotment − sold − held · missing inventory means unknown, zero means unavailable · amounts are integer minor units shown as currency{data.truncated ? ' · first plans only (limit reached)' : ''}</p>
            {data.rows.map((row, index) => {
              const sellable = row.cells.filter((c) => c.sellable).length
              return (
                <details key={row.ratePlanId} open={index === 0 || data.rows.length <= 2} style={{ marginBottom: 12 }} data-plan-id={row.ratePlanId}>
                  <summary style={{ cursor: 'pointer', padding: '6px 0' }}>
                    <strong>{row.roomName}</strong> · {row.boardCode} · <code>{row.ratePlanCode}</code> · {row.currency} · occ {row.occupancy} · {row.supplierName} · <Chip tone={row.planStatus === 'ACTIVE' ? 'ok' : 'warn'}>{row.planStatus}</Chip> · {sellable}/{row.cells.length} nights sellable
                  </summary>
                  <p style={{ margin: '4px 0 8px', fontSize: 11 }}>This view is read-only. <Link href={`/rates?ratePlanId=${encodeURIComponent(row.ratePlanId)}`}>Edit rates, allotment and stop-sell in the Rates &amp; Inventory workbench</Link>, which applies the existing validation and audit.</p>
                  <ScrollRegion label={`Calendar for ${row.ratePlanCode}`} maxHeight={420}>
                    <table style={tableStyle} aria-label={`Rates and inventory for ${row.ratePlanCode}`}>
                      <thead><tr>{['Date', 'Rate', 'Basis', 'Allotment', 'Sold', 'Held', 'Remaining', 'Stop sell', 'Min stay', 'Closed to arrival', 'Closed to departure', 'Source updated', 'Sellability'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                      <tbody>
                        {row.cells.map((cell) => (
                          <tr key={cell.date} data-date={cell.date} data-sellable={cell.sellable}>
                            <td style={td}>{cell.date}</td>
                            <td style={td}>{cell.rateMinor !== null && cell.currency ? <Money minor={cell.rateMinor} currency={cell.currency} /> : <Chip tone="bad">MISSING</Chip>}</td>
                            <td style={td}>{cell.amountBasis ?? '—'}</td>
                            <td style={td}>{cell.allotment ?? <Chip tone="bad">NO ROW</Chip>}</td>
                            <td style={td}>{cell.sold ?? '—'}</td><td style={td}>{cell.held ?? '—'}</td>
                            <td style={td}>{cell.remaining ?? '—'}</td>
                            <td style={td}>{cell.stopSell === null ? '—' : cell.stopSell ? <Chip tone="warn">STOP SELL</Chip> : 'No'}</td>
                            <td style={td}>{cell.minStay ?? '—'}</td>
                            <td style={td}>{cell.closedToArrival === null ? '—' : cell.closedToArrival ? <Chip tone="warn">CLOSED</Chip> : 'No'}</td>
                            <td style={td} title="Stored, but Agent search does not apply closed-to-departure yet.">{cell.closedToDeparture === null ? '—' : cell.closedToDeparture ? <Chip tone="neutral">RECORDED, NOT APPLIED</Chip> : 'No'}</td>
                            <td style={td}>{cell.rateSourceUpdatedAt || cell.availabilitySourceUpdatedAt ? <span title="Rate / availability source stamps">{cell.rateSourceUpdatedAt ? new Date(cell.rateSourceUpdatedAt).toLocaleDateString() : 'rate unknown'} / {cell.availabilitySourceUpdatedAt ? new Date(cell.availabilitySourceUpdatedAt).toLocaleDateString() : 'avail. unknown'}</span> : 'unknown'}</td>
                            <td style={td}>{cell.sellable ? <Tag tone="ok">SELLABLE</Tag> : <span><Tag tone="bad">NOT SELLABLE</Tag>{cell.reasons.map((r) => <div key={r} title={reasonText(r)}><code>{r}</code></div>)}</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </ScrollRegion>
                </details>
              )
            })}
          </div>
        )}
      </OpsState>
    </div>
  )
}
