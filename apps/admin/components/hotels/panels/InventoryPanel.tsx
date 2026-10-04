'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { INVENTORY_LIMITS, INVENTORY_MODES, type HotelCommercial360, type HotelInventorySummary, type InventoryPlanSummary, type InventoryPool } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { useCan } from '@/lib/auth/capabilities'
import { apiErrorParts } from '@/lib/hotel-setup-ui'
import { addInventoryPoolMembers, createInventoryPool, getInventorySummary, removeInventoryPoolMembers, setPlanRelease, updateInventoryPool } from '@/lib/data/hotel-inventory'
import { hotelHref } from '@/lib/hotel-ui'
import { Chip, ScrollRegion, td, th, tableStyle } from '../ui'
import { RatesInventoryPanel } from './RatesInventoryPanel'

const field = { display: 'grid', gap: 2, fontSize: 12, color: '#17333e' } as const
const note = { color: '#3f565c', fontSize: 11, margin: 0 } as const
const MODE_HELP: Record<string, string> = {
  ALLOTMENT: 'Sells while stock remains',
  FREE_SALE: 'Sells without counting stock',
  ON_REQUEST: 'Visible but never instant',
  CLOSED: 'Never sells',
}
type Failure = { message: string; details: string[]; requestId: string | null }

/**
 * Inventory & Allotment (ADR 0030): the one place to see and shape how a hotel's inventory sells. Counts, remaining units and
 * verdicts all come from the API; nothing here computes stock. A shared pool is one stock: three plans over 5 rooms show 5.
 * Every change sends the token of what is on screen, so a stale form is refused by the server instead of overwriting.
 */
export function InventoryPanel({ hotelId, rooms }: { hotelId: string; rooms: HotelCommercial360['rooms'] }) {
  const [days, setDays] = useState(14)
  const { state, reload, refresh } = useOpsQuery(() => getInventorySummary(hotelId, { days }), [hotelId, days])
  return (
    <div style={{ display: 'grid', gap: 16 }} data-testid="inventory-workspace">
      <section className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 12 }} aria-label="Inventory summary">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
          <h2 style={{ fontSize: 14, margin: 0 }}>Inventory summary</h2>
          <label style={field}>Nights shown<select className="input-wrap" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 14, 30, 62].map((d) => <option key={d} value={d}>{d}</option>)}</select></label>
        </div>
        <OpsState state={state} onRetry={reload} isEmpty={(d) => d.plans.length === 0} empty={{ title: 'No rate plans', description: 'This hotel has no rate plan, so there is no inventory to manage. Create a contract and rate plan first.' }}>
          {(data) => <SummaryBody hotelId={hotelId} data={data} onChanged={refresh} />}
        </OpsState>
      </section>
      <section aria-label="Inventory calendar" style={{ display: 'grid', gap: 8 }}>
        <h2 style={{ fontSize: 14, margin: 0 }}>Calendar</h2>
        <p style={note}>Each night shows its mode, which counter its remaining units come from (the plan itself or its shared pool), freshness and the canonical verdict. For bulk edits use <Link href={hotelHref(hotelId, 'quick')}>Quick Update</Link>.</p>
        <RatesInventoryPanel hotelId={hotelId} rooms={rooms} />
      </section>
    </div>
  )
}

function SummaryBody({ hotelId, data, onChanged }: { hotelId: string; data: HotelInventorySummary; onChanged: () => void }) {
  const can = useCan()
  const canManage = can('supply.availability.manage')
  const active = data.pools.filter((p) => p.status === 'ACTIVE')
  const archived = data.pools.filter((p) => p.status === 'ARCHIVED')
  return (
    <>
      <dl data-testid="inventory-totals" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px 16px', margin: 0 }}>
        <div><dt>Rate plans</dt><dd>{data.totals.plans}</dd></div>
        <div><dt>Plans in a shared pool</dt><dd>{data.totals.pooledPlans}</dd></div>
        <div><dt>Active pools</dt><dd>{data.totals.pools}</dd></div>
        <div><dt>Nights with no inventory row</dt><dd><Chip tone={data.totals.nightsMissing ? 'warn' : 'ok'}>{data.totals.nightsMissing}</Chip></dd></div>
        <div><dt>Stale nights</dt><dd><Chip tone={data.totals.nightsStale ? 'bad' : 'ok'}>{data.totals.nightsStale}</Chip></dd></div>
      </dl>
      <p style={note}>{data.window.from} → {data.window.to} · hotel time zone {data.timeZone}. Missing inventory means unknown, not zero. A stale night does not sell.</p>

      <h3 style={{ fontSize: 13, margin: '8px 0 0' }}>Shared allotment pools</h3>
      {active.length === 0 && <p data-testid="no-pools" style={{ fontSize: 12, margin: 0 }}>No shared pool. Each rate plan sells from its own allotment.</p>}
      {active.map((pool) => <PoolCard key={pool.id} hotelId={hotelId} pool={pool} data={data} canManage={canManage} onChanged={onChanged} />)}
      {archived.length > 0 && <details><summary style={{ fontSize: 12, cursor: 'pointer' }}>{archived.length} archived pool{archived.length === 1 ? '' : 's'}</summary><ul style={{ fontSize: 12 }}>{archived.map((p) => <li key={p.id}>{p.name} · {p.supplierName}</li>)}</ul></details>}
      {canManage ? <CreatePool hotelId={hotelId} data={data} onChanged={onChanged} /> : <p style={note} data-testid="read-only-note">You have read-only access: pools, release rules and stock cannot be changed with your permissions.</p>}

      <h3 style={{ fontSize: 13, margin: '8px 0 0' }}>Rate plans: modes and release rule</h3>
      <ScrollRegion label="Rate plan inventory"><table style={tableStyle} aria-label="Rate plan inventory">
        <thead><tr>{['Rate plan', 'Room · board', 'Supplier', 'Pool', ...INVENTORY_MODES, 'No row', 'Stale', 'Release rule'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
        <tbody>{data.plans.map((plan) => (
          <tr key={plan.ratePlanId} data-plan-id={plan.ratePlanId}>
            <td style={td}><code>{plan.ratePlanCode}</code> <Chip tone={plan.planStatus === 'ACTIVE' ? 'ok' : 'warn'}>{plan.planStatus}</Chip></td>
            <td style={td}>{plan.roomName} · {plan.boardCode}</td><td style={td}>{plan.supplierName}</td>
            <td style={td}>{plan.poolName ?? <span style={note}>none</span>}</td>
            {INVENTORY_MODES.map((m) => <td key={m} style={td} title={MODE_HELP[m]}>{plan.modeCounts[m]}</td>)}
            <td style={td}>{plan.nightsMissing}</td><td style={td}>{plan.nightsStale}</td>
            <td style={td}><ReleaseRule hotelId={hotelId} plan={plan} canManage={canManage} onChanged={onChanged} /></td>
          </tr>))}</tbody></table></ScrollRegion>
      <p style={note}>Modes: {INVENTORY_MODES.map((m) => `${m.replace('_', ' ')} = ${MODE_HELP[m].toLowerCase()}`).join(' · ')}. Counts are nights in the window. Release deadline: a plan stops selling a check-in at its release time, {`N`} hotel-local days before arrival.</p>
    </>
  )
}

function useMutation() {
  const [busy, setBusy] = useState(false); const [error, setError] = useState<Failure | null>(null); const [done, setDone] = useState<string | null>(null)
  const inFlight = useRef(false); const key = useRef<string | null>(null)
  async function run(action: string, work: (idempotencyKey: string) => Promise<unknown>, success: string, onChanged: () => void): Promise<boolean> {
    if (inFlight.current) return false
    inFlight.current = true; setBusy(true); setError(null); setDone(null); key.current ??= crypto.randomUUID()
    try { await work(key.current); key.current = null; setDone(success); onChanged(); return true }
    catch (e) { const p = apiErrorParts(e, action); setError({ message: p.message, details: p.details, requestId: p.requestId }); key.current = null; return false }
    finally { inFlight.current = false; setBusy(false) }
  }
  return { busy, error, done, run }
}
const ErrorBox = ({ error }: { error: Failure | null }) => error ? <div role="alert" className="admin-error" style={{ padding: 8, fontSize: 12 }}><strong>{error.message}</strong>{error.details.length > 0 && <ul>{error.details.map((d) => <li key={d}>{d}</li>)}</ul>}{error.requestId && <div style={note}>Request id: <code>{error.requestId}</code></div>}</div> : null

function PoolCard({ hotelId, pool, data, canManage, onChanged }: { hotelId: string; pool: InventoryPool; data: HotelInventorySummary; canManage: boolean; onChanged: () => void }) {
  const m = useMutation()
  const [name, setName] = useState(pool.name); const [add, setAdd] = useState('')
  const candidates = data.plans.filter((p) => !p.poolId && p.supplierId === pool.supplierId && p.planStatus !== 'EXPIRED')
  const token = pool.updatedAt
  return (
    <article className="workspace-panel" style={{ padding: 14, display: 'grid', gap: 8 }} data-testid="pool-card" data-pool-id={pool.id} aria-label={`Pool ${pool.name}`}>
      <header style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <strong>{pool.name}</strong><span style={note}>{pool.supplierName}</span><Chip tone="ok">ACTIVE</Chip>
        <Chip tone={pool.missingNights ? 'warn' : 'ok'} title="Nights of the window with no pool stock row">{pool.missingNights} night{pool.missingNights === 1 ? '' : 's'} with no stock</Chip>
      </header>
      <div><span style={{ fontSize: 12 }}>Plans sharing this pool: </span>
        {pool.members.length === 0 ? <span style={note}>none yet</span> : pool.members.map((mem) => (
          <span key={mem.ratePlanId} style={{ marginRight: 8, fontSize: 12 }} data-member={mem.ratePlanId}><code>{mem.ratePlanCode}</code> ({mem.roomName} · {mem.boardCode})
            {canManage && <button type="button" className="admin-btn" style={{ marginLeft: 4 }} aria-label={`Remove ${mem.ratePlanCode} from ${pool.name}`} disabled={m.busy} onClick={() => void m.run('remove the rate plan', (k) => removeInventoryPoolMembers(hotelId, pool.id, { ratePlanIds: [mem.ratePlanId], expectedUpdatedAt: token, idempotencyKey: k }), 'Rate plan removed from the pool.', onChanged)}>Remove</button>}
          </span>))}
      </div>
      <ScrollRegion label={`Stock of ${pool.name}`} maxHeight={260}><table style={tableStyle} aria-label={`Pool stock for ${pool.name}`}>
        <thead><tr>{['Date', 'Capacity', 'Sold', 'Held', 'Remaining', 'State'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
        <tbody>{pool.nights.map((n) => (
          <tr key={n.date} data-date={n.date}>
            <td style={td}>{n.date}</td><td style={td}>{n.capacity ?? '—'}</td><td style={td}>{n.sold ?? '—'}</td><td style={td}>{n.held ?? '—'}</td><td style={td}><strong>{n.remaining ?? '—'}</strong></td>
            <td style={td}>{n.capacity === null ? <Chip tone="warn">NO STOCK ROW (unknown)</Chip> : n.stale ? <Chip tone="bad">STALE</Chip> : n.remaining === 0 ? <Chip tone="bad">SOLD OUT</Chip> : <Chip tone="ok">OK</Chip>}</td>
          </tr>))}</tbody></table></ScrollRegion>
      <p style={note}>Capacity is shared: it is one count for every plan listed above, not one per plan. Change it in <Link href={hotelHref(hotelId, 'quick')}>Quick Update</Link> (Availability → Allotment, selecting any plan of this pool).</p>
      {canManage && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
          <label style={field}>Add a rate plan<select className="input-wrap" value={add} onChange={(e) => setAdd(e.target.value)}><option value="">Choose…</option>{candidates.map((c) => <option key={c.ratePlanId} value={c.ratePlanId}>{c.ratePlanCode} · {c.roomName} · {c.boardCode}</option>)}</select></label>
          <button type="button" className="admin-btn" disabled={m.busy || !add || pool.members.length >= INVENTORY_LIMITS.poolMembers} onClick={() => void m.run('add the rate plan', (k) => addInventoryPoolMembers(hotelId, pool.id, { ratePlanIds: [add], expectedUpdatedAt: token, idempotencyKey: k }), 'Rate plan added to the pool.', () => { setAdd(''); onChanged() })}>Add to pool</button>
          <label style={field}>Rename<input className="input-wrap" value={name} maxLength={INVENTORY_LIMITS.poolNameMax} onChange={(e) => setName(e.target.value)} /></label>
          <button type="button" className="admin-btn" disabled={m.busy || name.trim() === '' || name.trim() === pool.name} onClick={() => void m.run('rename the pool', (k) => updateInventoryPool(hotelId, pool.id, { name: name.trim(), expectedUpdatedAt: token, idempotencyKey: k }), 'Pool renamed.', onChanged)}>Save name</button>
          <button type="button" className="admin-btn" disabled={m.busy || pool.members.length > 0} title={pool.members.length ? 'Remove every rate plan first' : undefined} onClick={() => void m.run('archive the pool', (k) => updateInventoryPool(hotelId, pool.id, { archive: true, expectedUpdatedAt: token, idempotencyKey: k }), 'Pool archived.', onChanged)}>Archive pool</button>
        </div>)}
      <ErrorBox error={m.error} />{m.done && <p role="status" style={note}>{m.done}</p>}
    </article>
  )
}

function CreatePool({ hotelId, data, onChanged }: { hotelId: string; data: HotelInventorySummary; onChanged: () => void }) {
  const m = useMutation()
  const [name, setName] = useState(''); const [supplierId, setSupplierId] = useState(''); const [picked, setPicked] = useState<string[]>([])
  const suppliers = [...new Map(data.plans.map((p) => [p.supplierId, p.supplierName])).entries()]
  const candidates = data.plans.filter((p) => !p.poolId && p.supplierId === supplierId && p.planStatus !== 'EXPIRED')
  return (
    <form className="workspace-panel" style={{ padding: 14, display: 'grid', gap: 8 }} aria-label="Create a shared pool" data-testid="create-pool" onSubmit={(e) => { e.preventDefault(); void m.run('create the pool', (k) => createInventoryPool(hotelId, { name: name.trim(), supplierId, ratePlanIds: picked, idempotencyKey: k }), 'Pool created. Set its capacity in Quick Update.', () => { setName(''); setPicked([]); onChanged() }) }}>
      <strong style={{ fontSize: 13 }}>Create a shared pool</strong>
      <p style={note}>Plans of one supplier at this hotel can draw on one stock. A plan can be in one pool only. A plan that already has units sold or held cannot join until those nights are clear.</p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
        <label style={field}>Pool name<input className="input-wrap" value={name} maxLength={INVENTORY_LIMITS.poolNameMax} onChange={(e) => setName(e.target.value)} /></label>
        <label style={field}>Supplier<select className="input-wrap" value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setPicked([]) }}><option value="">Choose…</option>{suppliers.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      </div>
      {supplierId && <fieldset style={{ border: '1px solid #e6eef0', margin: 0, padding: 8 }}><legend style={{ fontSize: 12 }}>Rate plans to include</legend>
        {candidates.length === 0 ? <span style={note}>No unpooled rate plan for this supplier.</span> : candidates.map((c) => (
          <label key={c.ratePlanId} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={picked.includes(c.ratePlanId)} onChange={(e) => setPicked((s) => e.target.checked ? [...s, c.ratePlanId] : s.filter((x) => x !== c.ratePlanId))} />{c.ratePlanCode} · {c.roomName} · {c.boardCode}</label>))}
      </fieldset>}
      <div><button type="submit" className="button primary" data-testid="create-pool-submit" disabled={m.busy || name.trim() === '' || !supplierId}>{m.busy ? 'Creating…' : 'Create pool'}</button></div>
      <ErrorBox error={m.error} />{m.done && <p role="status" style={note}>{m.done}</p>}
    </form>
  )
}

function ReleaseRule({ hotelId, plan, canManage, onChanged }: { hotelId: string; plan: InventoryPlanSummary; canManage: boolean; onChanged: () => void }) {
  const m = useMutation()
  const [open, setOpen] = useState(false); const [releaseDays, setReleaseDays] = useState(String(plan.releaseDays)); const [time, setTime] = useState(plan.releaseTimeLocal); const [reason, setReason] = useState('')
  const label = `${plan.releaseDays} day${plan.releaseDays === 1 ? '' : 's'} before check-in at ${plan.releaseTimeLocal}`
  if (!open) return <span>{label} {canManage && <button type="button" className="admin-btn" aria-label={`Edit release rule of ${plan.ratePlanCode}`} onClick={() => setOpen(true)}>Edit</button>}</span>
  const daysValue = Number(releaseDays)
  const valid = Number.isInteger(daysValue) && daysValue >= 0 && daysValue <= INVENTORY_LIMITS.releaseDaysMax && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time) && reason.trim().length >= 3
  return (
    <form style={{ display: 'grid', gap: 6, minWidth: 230 }} aria-label={`Release rule of ${plan.ratePlanCode}`} onSubmit={(e) => { e.preventDefault(); void m.run('change the release rule', (k) => setPlanRelease(hotelId, plan.ratePlanId, { releaseDays: daysValue, releaseTimeLocal: time, expectedUpdatedAt: plan.updatedAt, reason: reason.trim(), idempotencyKey: k }), 'Release rule saved.', () => { setOpen(false); onChanged() }) }}>
      <label style={field}>Days before check-in<input className="input-wrap" inputMode="numeric" value={releaseDays} onChange={(e) => setReleaseDays(e.target.value)} /></label>
      <label style={field}>Cut-off time (hotel local, 24h)<input className="input-wrap" value={time} placeholder="18:00" onChange={(e) => setTime(e.target.value)} /></label>
      <label style={field}>Reason (audited)<input className="input-wrap" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></label>
      <div style={{ display: 'flex', gap: 6 }}><button type="submit" className="button primary" disabled={m.busy || !valid}>{m.busy ? 'Saving…' : 'Save'}</button><button type="button" className="admin-btn" onClick={() => setOpen(false)}>Cancel</button></div>
      <ErrorBox error={m.error} />
    </form>
  )
}
