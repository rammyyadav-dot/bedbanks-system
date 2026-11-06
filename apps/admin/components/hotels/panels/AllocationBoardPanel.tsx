'use client'

import { useState } from 'react'
import type { AllocationBoard, PostReleasePolicy } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { useCan } from '@/lib/auth/capabilities'
import { apiErrorParts } from '@/lib/hotel-setup-ui'
import { applyAllocation, getAllocationBoard, releaseAllocation } from '@/lib/data/room-sales'

export function AllocationBoardPanel({ hotelId }: { hotelId: string }) {
  const [days, setDays] = useState(14)
  const [from, setFrom] = useState('')
  const { state, reload, refresh } = useOpsQuery(() => getAllocationBoard(hotelId, { from: from || undefined, days }), [hotelId, from, days])
  return <section className="room-sales" aria-label="Allocation management"><OpsState state={state} onRetry={reload} isEmpty={(data) => data.rows.length === 0} empty={{ title: 'No room types', description: 'This hotel has no active room type, so there is no allocation to manage.' }}>{(data) => <Board hotelId={hotelId} data={data} days={days} setDays={setDays} setFrom={setFrom} onSaved={refresh} />}</OpsState></section>
}

function Board({ hotelId, data, days, setDays, setFrom, onSaved }: { hotelId: string; data: AllocationBoard; days: number; setDays: (n: number) => void; setFrom: (v: string) => void; onSaved: () => void }) {
  const canManage = useCan()('supply.availability.manage')
  const pools = [...new Map(data.rows.filter((row) => row.poolId).map((row) => [row.poolId, row.poolName])).entries()]
  const [poolId, setPoolId] = useState(pools[0]?.[0] ?? '')
  const [contracted, setContracted] = useState('0')
  const [adjustment, setAdjustment] = useState('0')
  const [blocked, setBlocked] = useState('0')
  const [excluded, setExcluded] = useState(false)
  const [policy, setPolicy] = useState<PostReleasePolicy>('CLOSED')
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fingerprint = data.fingerprints.find((item) => item.poolId === poolId)?.fingerprint ?? null
  async function save(kind: 'apply' | 'release') {
    if (!poolId || !fingerprint || !canManage) return
    setError(null); setMessage(null)
    try {
      const common = { poolId, from: data.window.from, to: data.window.to, reason, idempotencyKey: crypto.randomUUID(), expectedFingerprint: fingerprint }
      const result = kind === 'release' ? (await releaseAllocation(hotelId, common)).data : (await applyAllocation(hotelId, { ...common, contracted: Number(contracted), approvedAdjustment: Number(adjustment), blocked: Number(blocked), blockedExcludedFromAllocation: excluded, postReleasePolicy: policy, releaseCutoffDays: null, releaseTimeLocal: null })).data
      setMessage(`${result.replayed ? 'Already saved.' : 'Saved.'} ${result.updated} nights. ${result.overCommitmentNights.length ? `Existing bookings remain on ${result.overCommitmentNights.join(', ')} and further sales are blocked.` : 'No night is below existing commitments.'}`)
      onSaved()
    } catch (cause) { setError(apiErrorParts(cause, 'save the allocation').message) }
  }
  return <div className="room-sales-board">
    <header className="room-sales-heading"><div><h2>Allocation Management</h2><p>{data.hotelName} · hotel time {data.timeZone} · today {data.hotelToday}</p></div>{data.notes.map((note) => <p key={note} className="room-sales-note">{note}</p>)}</header>
    <div className="room-sales-nav"><button type="button" onClick={() => setFrom(shift(data.window.from, -days))}>Previous</button><button type="button" onClick={() => setFrom(data.hotelToday)}>Today</button><button type="button" onClick={() => setFrom(shift(data.window.from, days))}>Next</button><label>Days<select value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={7}>7</option><option value={14}>14</option><option value={28}>28</option></select></label><p>{data.window.from} – {data.window.to}</p></div>
    <div className="room-sales-scroll"><table className="room-sales-grid allocation-grid"><thead><tr><th className="room-sales-sticky">Room and pool</th>{data.dates.map((date) => <th key={date}>{date.slice(8)}</th>)}</tr></thead><tbody>{data.rows.map((row) => <tr key={`${row.roomTypeId}-${row.poolId ?? 'own'}`}><th className="room-sales-sticky">{row.roomName}<small>{row.poolName}</small></th>{row.nights.map((night) => <td key={night.stayDate}>{night.exists ? <span>{night.remaining ?? 'Unknown'} left<small>Contracted {night.contracted} · adj {night.approvedAdjustment} · booked {night.confirmed} · held {night.activeHolds} · blocked {night.blocked}</small>{night.overCommitment && <small>Below existing bookings</small>}</span> : <span>No stock row</span>}</td>)}</tr>)}</tbody></table></div>
    {canManage && <form className="room-sales-bulk" onSubmit={(event) => { event.preventDefault(); void save('apply') }}><h3>Update allocation</h3><label>Pool<select value={poolId ?? ''} onChange={(event) => setPoolId(event.target.value)}>{pools.map(([id, name]) => <option key={id} value={id ?? ''}>{name}</option>)}</select></label><label>Contracted<input inputMode="numeric" value={contracted} onChange={(event) => setContracted(event.target.value)} /></label><label>Approved adjustment<input inputMode="numeric" value={adjustment} onChange={(event) => setAdjustment(event.target.value)} /></label><label>Blocked<input inputMode="numeric" value={blocked} onChange={(event) => setBlocked(event.target.value)} /></label><label className="room-sales-check"><input type="checkbox" checked={excluded} onChange={(event) => setExcluded(event.target.checked)} />Blocked rooms are already excluded from the contracted figure</label><label>After release<select value={policy} onChange={(event) => setPolicy(event.target.value as PostReleasePolicy)}><option value="CLOSED">Closed</option><option value="ON_REQUEST">On Request</option><option value="AUTHORIZED_FREE_SALE">Authorized free sale</option></select></label><label>Reason<input value={reason} onChange={(event) => setReason(event.target.value)} /></label><button type="submit" disabled={!fingerprint || reason.trim().length < 3}>Save allocation</button><button type="button" disabled={!fingerprint || reason.trim().length < 3} onClick={() => void save('release')}>Release unused allocation</button>{!fingerprint && <p>A night in this window has no stock row, so this pool cannot be saved from here.</p>}</form>}
    {message && <p role="status">{message}</p>}{error && <p className="room-sales-warn" role="alert">{error}</p>}
  </div>
}
function shift(date: string, days: number) { return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10) }
