'use client'

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { HOTEL_POLICY_KEYS, HOTEL_POLICY_LABELS, type HotelContractRow, type HotelPolicyKey, type HotelSetupView } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { useCan } from '@/lib/auth/capabilities'
import { apiErrorParts } from '@/lib/hotel-setup-ui'
import { getHotelSetup, saveHotelSetup } from '@/lib/data/hotel-setup'
import { getHotelContracts } from '@/lib/data/hotel-commercial'
import { getContract, type AdminContractDetail } from '@/lib/data'
import { formatMinorUnits } from '@/lib/minor-units'
import { hotelHref } from '@/lib/hotel-ui'
import { ScrollRegion, td, th, tableStyle } from '../ui'

const note = { color: '#3f565c', fontSize: 11, margin: 0 } as const
const field = { display: 'grid', gap: 2, fontSize: 12, color: '#17333e' } as const

/**
 * Hotel-level information policies, kept apart from rate-specific cancellation terms. The first are edited here (saved through the
 * Hotel Setup API); the second are shown read-only from each contract and are never overwritten by a hotel policy.
 */
export function PoliciesPanel({ hotelId }: { hotelId: string }) {
  const [version, setVersion] = useState(0)
  const [flash, setFlash] = useState<string | null>(null)
  const { state, reload } = useOpsQuery(() => getHotelSetup(hotelId), [hotelId, version])
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <OpsState state={state} onRetry={reload}>
        {(setup) => (
          <>
            {flash && <div role="status" data-testid="policies-flash" className="workspace-panel" style={{ padding: 12 }}><strong>{flash}</strong></div>}
            <HotelPolicies key={setup.concurrencyToken} hotelId={hotelId} setup={setup} onSaved={(t) => { setFlash(t); setVersion((v) => v + 1) }} />
          </>
        )}
      </OpsState>
      <ContractTerms hotelId={hotelId} />
    </div>
  )
}

function HotelPolicies({ hotelId, setup, onSaved }: { hotelId: string; setup: HotelSetupView; onSaved: (text: string) => void }) {
  const can = useCan(); const canManage = can('supply.hotels.manage')
  const initial = useMemo(() => Object.fromEntries(HOTEL_POLICY_KEYS.map((k) => [k, setup.policies[k] ?? ''])) as Record<HotelPolicyKey, string>, [setup.policies])
  const [form, setForm] = useState(initial)
  const [busy, setBusy] = useState(false); const inFlight = useRef(false); const key = useRef<string | null>(null)
  const [error, setError] = useState<{ message: string; details: string[]; requestId: string | null; stale: boolean } | null>(null)
  const dirty = JSON.stringify(form) !== JSON.stringify(initial)
  async function save() {
    if (inFlight.current || !dirty) return
    inFlight.current = true; setBusy(true); setError(null); key.current ??= crypto.randomUUID()
    try {
      const policies = Object.fromEntries(HOTEL_POLICY_KEYS.map((k) => [k, form[k].trim() === '' ? null : form[k].trim()]))
      const { data } = await saveHotelSetup(hotelId, { idempotencyKey: key.current, expectedToken: setup.concurrencyToken, policies })
      key.current = null; onSaved(`Hotel policies saved. Request id ${data.auditRequestId || 'not recorded'}.`)
    } catch (e) { const p = apiErrorParts(e, 'save the hotel policies'); setError({ message: p.message, details: p.details, requestId: p.requestId, stale: p.code === 'HOTEL_SETUP_STALE' }) } finally { inFlight.current = false; setBusy(false) }
  }
  return (
    <form className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 12 }} aria-label="Hotel policies" data-testid="policies-form" onSubmit={(e) => { e.preventDefault(); void save() }}>
      <h2 style={{ fontSize: 14, margin: 0 }}>Hotel policies</h2>
      <p style={note}>Hotel information only. Check-in is {setup.operations.checkInTime ?? 'not recorded'} and check-out is {setup.operations.checkOutTime ?? 'not recorded'} (hotel local time); change them in <Link href={hotelHref(hotelId, 'setup')}>Hotel Setup</Link>.</p>
      {HOTEL_POLICY_KEYS.map((k) => <label key={k} style={field}>{HOTEL_POLICY_LABELS[k]}<textarea className="input-wrap" rows={2} maxLength={1000} value={form[k]} readOnly={!canManage} onChange={(e) => { key.current = null; setForm({ ...form, [k]: e.target.value }) }} /></label>)}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        {canManage ? <button type="submit" className="button primary" disabled={busy || !dirty} data-testid="policies-save">{busy ? 'Saving…' : 'Save policies'}</button> : <span style={note}>You can view these policies but not change them.</span>}
        {dirty && <button type="button" className="admin-btn" disabled={busy} onClick={() => setForm(initial)}>Discard edits</button>}
      </div>
      {error && <div role="alert" data-testid="policies-error" className="admin-error" style={{ padding: 12 }}><strong>{error.message}</strong>{error.details.length > 0 && <ul>{error.details.map((d) => <li key={d}>{d}</li>)}</ul>}{error.requestId && <div style={note}>Request id: <code>{error.requestId}</code></div>}{error.stale && <div style={note}>Reload the page to load the latest version.</div>}</div>}
    </form>
  )
}

function ContractTerms({ hotelId }: { hotelId: string }) {
  const can = useCan()
  const allowed = can('supply.contracts.read')
  const { state, reload } = useOpsQuery(async () => {
    if (!allowed) return null
    const contracts = (await getHotelContracts(hotelId)).contracts.slice(0, 20)
    return Promise.all(contracts.map(async (c: HotelContractRow) => ({ row: c, detail: await getContract(c.id) as AdminContractDetail })))
  }, [hotelId, allowed])
  return (
    <section className="workspace-panel" style={{ padding: 18 }} aria-label="Rate-specific cancellation terms" data-testid="contract-terms">
      <h2 style={{ fontSize: 14, margin: '0 0 6px' }}>Rate-specific cancellation terms</h2>
      <p style={note}>These come from each contract and apply to the rates sold under it. A hotel policy above never replaces them. Edit them on the contract.</p>
      {!allowed ? <p style={{ fontSize: 12 }}>Contract terms need the contract read permission.</p> : (
        <OpsState state={state} onRetry={reload} isEmpty={(d) => !d || d.length === 0} empty={{ title: 'No contracts', description: 'This hotel has no contract, so no cancellation terms apply to any rate.' }}>
          {(items) => (
            <ScrollRegion label="Contract cancellation terms"><table style={tableStyle} aria-label="Contract cancellation terms">
              <thead><tr>{['Contract', 'Supplier', 'Cancellation policy', 'Booking lead time'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
              <tbody>{items!.map(({ row, detail }) => {
                const lead = Array.isArray(detail.leadTimeRules) ? detail.leadTimeRules[0] : detail.leadTimeRules
                return (
                  <tr key={row.id}>
                    <td style={td}><Link href={`/contracts/${row.id}`}>{row.code}</Link></td><td style={td}>{row.supplierName}</td>
                    <td style={td}>{detail.cancellationPolicies.length === 0 ? 'No cancellation policy defined' : <ul style={{ margin: 0, paddingLeft: 14 }}>{detail.cancellationPolicies.map((p) => <li key={p.id}>{p.daysBeforeCheckin} days before check-in: {p.penaltyPercent != null ? `${p.penaltyPercent}% penalty` : (p as { penaltyMinor?: string | null; currency?: string | null }).penaltyMinor != null ? `${formatMinorUnits(String((p as { penaltyMinor: string }).penaltyMinor), String((p as { currency?: string }).currency ?? ''))} penalty` : 'penalty not stated'}</li>)}</ul>}</td>
                    <td style={td}>{lead ? `Minimum ${lead.minLeadHours} hours${lead.maxLeadDays != null ? `, up to ${lead.maxLeadDays} days ahead` : ''}` : 'No lead-time rule'}</td>
                  </tr>
                )
              })}</tbody></table></ScrollRegion>
          )}
        </OpsState>
      )}
    </section>
  )
}
