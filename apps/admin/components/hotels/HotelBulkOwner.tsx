'use client'

import { useRef, useState } from 'react'
import type { HotelOwnerCandidate } from '@bedbanks/contracts'
import { BULK_OWNER_MAX, assignOwners, bulkOwnerProblem, type BulkOwnerOutcome } from '@/lib/hotel-bulk-owner'
import { getHotelSetup, getOwnerCandidates, saveHotelSetup } from '@/lib/data/hotel-setup'

const person = (p: HotelOwnerCandidate) => (p.name ? `${p.name} (${p.email})` : p.email)

/** Assigns one internal owner to the selected hotels through the normal Setup save. The API authorizes, version-checks, audits and de-duplicates each hotel. */
export function HotelBulkOwner({ hotels, onDone, onClear }: { hotels: Array<{ id: string; name: string }>; onDone: () => void; onClear: () => void }) {
  const ids = hotels.map((h) => h.id)
  const [search, setSearch] = useState(''); const [options, setOptions] = useState<HotelOwnerCandidate[] | null>(null)
  const [owner, setOwner] = useState(''); const [clear, setClear] = useState(false); const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [results, setResults] = useState<BulkOwnerOutcome[] | null>(null)
  const keys = useRef(new Map<string, string>())
  const target = clear ? null : owner
  const problem = bulkOwnerProblem(ids, target, reason)
  const names = new Map(hotels.map((h) => [h.id, h.name]))

  async function find() { setError(null); try { setOptions(await getOwnerCandidates(ids[0]!, search)) } catch { setOptions(null); setError('Members could not be loaded. You may lack permission to list members.') } }
  async function run() {
    if (busy || problem) return
    setBusy(true); setError(null)
    for (const id of ids) if (!keys.current.has(id)) keys.current.set(id, crypto.randomUUID())
    try {
      const out = await assignOwners(ids, target, reason, {
        getToken: async (id) => { const s = await getHotelSetup(id); return { token: s.concurrencyToken, currentOwnerUserId: s.governance.ownerUserId } },
        save: async (id, body) => { const { data } = await saveHotelSetup(id, body); return { replayed: data.replayed } },
        newKey: () => crypto.randomUUID(),
      }, keys.current)
      setResults(out); if (out.some((o) => o.status === 'assigned')) onDone()
    } catch (e) { setError(e instanceof Error ? e.message : 'The bulk change could not start.') } finally { setBusy(false) }
  }
  const failed = results?.filter((r) => r.status === 'failed') ?? []
  return (
    <section className="workspace-panel" aria-label="Bulk owner assignment" data-testid="bulk-owner" style={{ padding: 12, margin: '0 0 12px', display: 'grid', gap: 8, fontSize: 12 }}>
      <strong>{hotels.length} hotel{hotels.length === 1 ? '' : 's'} selected (max {BULK_OWNER_MAX}) · assign internal owner</strong>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input aria-label="Search members" placeholder="Search members" value={search} maxLength={64} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void find() } }} />
        <button type="button" className="admin-btn" onClick={() => void find()}>Find</button>
        {options && (options.length === 0 ? <span>No members match.</span> : <select aria-label="Choose owner" value={owner} disabled={clear} onChange={(e) => setOwner(e.target.value)}><option value="">Choose owner</option>{options.map((o) => <option key={o.userId} value={o.userId}>{person(o)}</option>)}</select>)}
        <label><input type="checkbox" checked={clear} onChange={(e) => setClear(e.target.checked)} /> Clear owner instead</label>
      </div>
      <label style={{ display: 'grid', gap: 2 }}><span>Reason (recorded in each hotel's audit trail)</span><input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="button primary" disabled={busy || problem !== null} onClick={() => void run()}>{busy ? 'Applying…' : failed.length ? 'Retry' : 'Apply to selected'}</button>
        <button type="button" className="admin-btn" disabled={busy} onClick={onClear}>Clear selection</button>
        {problem && reason && <span role="note">{problem}</span>}
      </div>
      {error && <p role="alert" style={{ margin: 0, color: 'var(--c-9a1c1c)' }}>{error}</p>}
      {results && (
        <div role="status" data-testid="bulk-owner-results">
          <p style={{ margin: 0 }}>{results.filter((r) => r.status === 'assigned').length} assigned · {results.filter((r) => r.status === 'unchanged').length} already set · {failed.length} failed. Each change is audited per hotel.</p>
          {failed.length > 0 && <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>{failed.map((f) => <li key={f.hotelId}>{names.get(f.hotelId) ?? f.hotelId}: {f.message}</li>)}</ul>}
        </div>
      )}
    </section>
  )
}
