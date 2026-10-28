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
import { DraftStatus, SaveFailureNotice, type SaveFailure } from '../DraftNotices'
import { useDraftRecovery } from '../useDraftRecovery'
import { useDraftState } from '../useDraftState'
import { useUnsavedChanges } from '../useUnsavedChanges'
import { LocalChargesEditor } from './LocalChargesEditor'

const note = { color: 'var(--c-444444)', fontSize: 11, margin: 0 } as const
const field = { display: 'grid', gap: 2, fontSize: 12, color: 'var(--c-111111)' } as const

type PolicyDraft = Record<HotelPolicyKey, string>
const policiesOf = (setup: HotelSetupView): PolicyDraft => Object.fromEntries(HOTEL_POLICY_KEYS.map((k) => [k, setup.policies[k] ?? ''])) as PolicyDraft
const isPolicyDraft = (v: unknown): v is PolicyDraft => !!v && typeof v === 'object' && HOTEL_POLICY_KEYS.every((k) => typeof (v as Record<string, unknown>)[k] === 'string')

/**
 * Hotel-level information policies, kept apart from rate-specific cancellation terms. The first are edited here (saved through the
 * Hotel Setup API); the second are shown read-only from each contract and are never overwritten by a hotel policy.
 */
export function PoliciesPanel({ hotelId, onChanged }: { hotelId: string; onChanged?: () => void }) {
  const { state, reload } = useOpsQuery(() => getHotelSetup(hotelId), [hotelId])
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <OpsState state={state} onRetry={reload}>
        {(loaded) => <PolicyEditors hotelId={hotelId} loaded={loaded} onChanged={onChanged} />}
      </OpsState>
      <ContractTerms hotelId={hotelId} />
    </div>
  )
}

/**
 * The two editors share one stored version (and so one concurrency token) but keep independent drafts. A save by either replaces the shared version
 * with what the server returned; it never remounts the editors, so the other editor's unsaved edits are merged onto the new version, not dropped.
 * Only one save runs at a time, because both would otherwise race on the same token.
 */
function PolicyEditors({ hotelId, loaded, onChanged }: { hotelId: string; loaded: HotelSetupView; onChanged?: () => void }) {
  const [setup, setSetup] = useState(loaded)
  const [flash, setFlash] = useState<string | null>(null)
  const [saving, setSaving] = useState<'policies' | 'charges' | null>(null)
  const onSaving = (who: 'policies' | 'charges') => (on: boolean) => { setSaving(on ? who : null); if (on) setFlash(null) }
  const onSaved = (text: string, next: HotelSetupView) => { setSetup(next); setFlash(text); onChanged?.() }
  return (
    <>
      {flash && <div role="status" data-testid="policies-flash" className="workspace-panel" style={{ padding: 12 }}><strong>{flash}</strong></div>}
      <HotelPolicies hotelId={hotelId} setup={setup} otherSaving={saving === 'charges'} onSaving={onSaving('policies')} onSaved={onSaved} onLoadLatest={setSetup} />
      <LocalChargesEditor hotelId={hotelId} setup={setup} otherSaving={saving === 'policies'} onSaving={onSaving('charges')} onSaved={onSaved} onLoadLatest={setSetup} />
    </>
  )
}

function HotelPolicies({ hotelId, setup, otherSaving, onSaving, onSaved, onLoadLatest }: {
  hotelId: string; setup: HotelSetupView; otherSaving: boolean
  onSaving: (on: boolean) => void; onSaved: (text: string, next: HotelSetupView) => void; onLoadLatest: (latest: HotelSetupView) => void
}) {
  const can = useCan(); const canManage = can('supply.hotels.manage')
  const baseline = useMemo(() => policiesOf(setup), [setup])
  const draft = useDraftState<PolicyDraft>(baseline)
  const [busy, setBusy] = useState(false); const inFlight = useRef(false); const key = useRef<string | null>(null)
  const [error, setError] = useState<SaveFailure | null>(null)
  useUnsavedChanges(draft.dirty)
  const recovery = useDraftRecovery<PolicyDraft>({ scope: 'policies', hotelId, base: baseline, value: draft.draft, dirty: draft.dirty, valid: isPolicyDraft, onRestore: (r) => draft.restore(r.base, r.value) })
  const edit = (k: HotelPolicyKey, text: string) => { key.current = null; draft.setDraft((d) => ({ ...d, [k]: text })) }
  const discard = () => { key.current = null; setError(null); recovery.dismiss(); draft.reset() }

  async function save() {
    if (inFlight.current || !draft.dirty || otherSaving) return
    // Edits typed while this request is in flight stay in the form: only what was submitted is reconciled with the server's answer.
    const submitted = draft.draft
    inFlight.current = true; setBusy(true); onSaving(true); setError(null); key.current ??= crypto.randomUUID()
    try {
      const policies = Object.fromEntries(HOTEL_POLICY_KEYS.map((k) => [k, submitted[k].trim() === '' ? null : submitted[k].trim()]))
      const { data } = await saveHotelSetup(hotelId, { idempotencyKey: key.current, expectedToken: setup.concurrencyToken, policies })
      key.current = null; recovery.dismiss()
      draft.markSaved(submitted, policiesOf(data.setup))
      onSaved(`Hotel policies saved. Request id ${data.auditRequestId || 'not recorded'}.`, data.setup)
    } catch (e) {
      const p = apiErrorParts(e, 'save the hotel policies') // the draft and its idempotency key are kept, so retrying the same content is a safe replay
      setError({ message: p.message, details: p.details, requestId: p.requestId, stale: p.code === 'HOTEL_SETUP_STALE' })
    } finally { inFlight.current = false; setBusy(false); onSaving(false) }
  }
  async function loadLatest(keepEdits: boolean) {
    setBusy(true)
    try {
      const latest = await getHotelSetup(hotelId)
      key.current = null; setError(null)
      if (!keepEdits) draft.reset(policiesOf(latest))
      onLoadLatest(latest)
    } catch (e) { const p = apiErrorParts(e, 'load the latest hotel version'); setError({ message: p.message, details: p.details, requestId: p.requestId, stale: true }) } finally { setBusy(false) }
  }
  return (
    <form className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 12 }} aria-label="Hotel policies" aria-busy={busy} data-testid="policies-form" onSubmit={(e) => { e.preventDefault(); void save() }}>
      <h2 style={{ fontSize: 14, margin: 0 }}>Hotel policies</h2>
      <p style={note}>Hotel information only. Check-in is {setup.operations.checkInTime ?? 'not recorded'} and check-out is {setup.operations.checkOutTime ?? 'not recorded'} (hotel local time); change them in <Link href={hotelHref(hotelId, 'setup')}>Hotel Setup</Link>.</p>
      <DraftStatus recoveredAt={recovery.recovered?.savedAt ?? null} conflicts={draft.conflicts.map((k) => HOTEL_POLICY_LABELS[k])} busy={busy} onDiscard={discard} onDismiss={() => { recovery.dismiss(); draft.clearConflicts() }} />
      {HOTEL_POLICY_KEYS.map((k) => <label key={k} style={field}>{HOTEL_POLICY_LABELS[k]}<textarea className="input-wrap" rows={2} maxLength={1000} value={draft.draft[k]} readOnly={!canManage} onChange={(e) => edit(k, e.target.value)} /></label>)}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        {canManage ? <button type="submit" className="button primary" disabled={busy || otherSaving || !draft.dirty} data-testid="policies-save">{busy ? 'Saving…' : 'Save policies'}</button> : <span style={note}>You can view these policies but not change them.</span>}
        {draft.dirty && <button type="button" className="admin-btn" disabled={busy} onClick={discard}>Discard edits</button>}
        {otherSaving && <span style={note} role="status">Waiting for the local charges save to finish…</span>}
      </div>
      {error && <SaveFailureNotice failure={error} testId="policies-error" busy={busy} onKeepMine={() => void loadLatest(true)} onDiscardMine={() => void loadLatest(false)} />}
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
