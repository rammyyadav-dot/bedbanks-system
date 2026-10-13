'use client'

import { useEffect, useRef, useState } from 'react'
import type { DerivedRateMode, RatePlanDerivation } from '@bedbanks/contracts'
import { FormField } from '@/components/forms/FormField'
import { describeApiError } from '@/lib/api/describe-error'
import { useCan } from '@/lib/auth/capabilities'
import { basisPointsToSignedPercent, blankDerivation, buildDerivationInput, describeDerivation, minorToSignedMajor, type DerivationDraft } from '@/lib/derivation'
import { getDerivation, replaceDerivation } from '@/lib/data'

/**
 * Derived pricing of one rate plan (ADR 0058, S10b). A derived plan sells at its parent's nightly rate for the same date, adjusted, and has no rates of its own.
 * Availability, restrictions and pool membership stay the plan's own. Only a Draft or Suspended plan can change its price source. The API validates and is the authority.
 */
export function DerivationPanel({ ratePlanId }: { ratePlanId: string }) {
  const canManage = useCan()('supply.rates.manage')
  const [view, setView] = useState<RatePlanDerivation | null>(null)
  const [draft, setDraft] = useState<DerivationDraft>(blankDerivation())
  const [loadError, setLoadError] = useState<string | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  // A late initial load must not overwrite what the person has already chosen (see PromotionsPanel).
  const touched = useRef(false)

  const adopt = (next: RatePlanDerivation) => {
    setView(next)
    setDraft(next.derived ? { parentId: next.derived.parentId, mode: next.derived.mode, amount: next.derived.mode === 'PERCENT_BP' ? basisPointsToSignedPercent(next.derived.adjustment) : minorToSignedMajor(next.derived.adjustment, next.currency) } : blankDerivation())
  }
  const load = () => getDerivation(ratePlanId).then((loaded) => { if (touched.current) return; adopt(loaded); setLoadError(null) }).catch((error) => setLoadError(describeApiError(error, 'load the derived pricing')))
  useEffect(() => { void load() }, [ratePlanId])

  const change = (patch: Partial<DerivationDraft>) => { touched.current = true; setProblems([]); setMessage(null); setDraft((cur) => ({ ...cur, ...patch })) }
  const editable = canManage && view !== null && (view.status === 'DRAFT' || view.status === 'SUSPENDED')

  async function save() {
    if (!view) return
    const built = buildDerivationInput(draft, view.currency, view.updatedAt)
    setProblems(built.problems)
    if (!built.input) return
    await send(built.input, 'Derived pricing saved. Any activation approval filed before this change is void.')
  }
  async function clear() {
    if (!view) return
    await send({ expectedUpdatedAt: view.updatedAt, parentId: null }, 'Derivation removed. The plan now needs its own rates.')
  }
  async function send(input: Parameters<typeof replaceDerivation>[1], ok: string) {
    setBusy(true); setMessage(null)
    try { const saved = await replaceDerivation(ratePlanId, input); touched.current = false; adopt(saved); setMessage({ kind: 'ok', text: ok }) }
    catch (error) { setMessage({ kind: 'error', text: describeApiError(error, 'save the derived pricing') }) } finally { setBusy(false) }
  }

  if (loadError) return <p role="alert" style={{ color: '#a11d1d', fontSize: 12 }}>{loadError}</p>
  if (!view) return <p role="status" style={{ fontSize: 12 }}>Loading derived pricing…</p>
  return (
    <section className="workspace-panel" style={{ maxWidth: 760, padding: 22, marginTop: 16 }} aria-label="Derived pricing">
      <h2 style={{ fontSize: 14, margin: '0 0 6px' }}>Derived pricing</h2>
      <p style={{ margin: '0 0 10px', fontSize: 12, color: '#3f565c' }}>
        {view.derived ? `${describeDerivation({ parentCode: view.derived.parentCode, mode: view.derived.mode, adjustment: view.derived.adjustment }, view.currency)}. This plan has no rates of its own; its price follows the parent, night by night. It sells only while the parent is active.`
          : 'This plan has its own rates. A derived plan instead sells at another plan’s rate, adjusted by a percentage or a fixed amount.'}
      </p>
      {view.hasDerivedPlans ? <p style={{ fontSize: 12 }}>Other plans are derived from this one, so it cannot itself be derived.</p>
        : view.hasOwnRates && !view.derived ? <p style={{ fontSize: 12 }}>This plan holds its own rates. Delete them before deriving it from another plan.</p>
        : editable ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end', marginBottom: 6 }}>
            <FormField label="Derived from"><select value={draft.parentId} onChange={(e) => change({ parentId: e.target.value })} aria-label="Parent rate plan"><option value="">Choose a plan…</option>{view.candidates.map((c) => <option key={c.id} value={c.id}>{c.code} ({c.roomName})</option>)}</select></FormField>
            <FormField label="Adjust by"><select value={draft.mode} onChange={(e) => change({ mode: e.target.value as DerivedRateMode, amount: '' })} aria-label="Adjustment type"><option value="PERCENT_BP">Percent</option><option value="FIXED_MINOR">Fixed amount ({view.currency})</option></select></FormField>
            <FormField label={draft.mode === 'PERCENT_BP' ? 'Percent (negative = cheaper)' : `Amount, ${view.currency} (negative = cheaper)`}><input inputMode="decimal" size={9} value={draft.amount} onChange={(e) => change({ amount: e.target.value })} aria-label="Adjustment" /></FormField>
          </div>
        ) : view.status !== 'DRAFT' && view.status !== 'SUSPENDED' ? <p style={{ fontSize: 12 }}>A {view.status.toLowerCase()} plan keeps its price source. Suspend it first to change how it is priced.</p> : null}
      {problems.length ? <ul role="alert" style={{ margin: '6px 0', paddingLeft: 16, fontSize: 12, color: '#a11d1d' }}>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul> : null}
      {message ? <p role={message.kind === 'error' ? 'alert' : 'status'} style={{ color: message.kind === 'error' ? '#a11d1d' : '#1f7a5a', fontSize: 12 }}>{message.text}</p> : null}
      {editable && !view.hasDerivedPlans && !(view.hasOwnRates && !view.derived) ? (
        <span style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="admin-btn admin-btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : view.derived ? 'Save derived pricing' : 'Derive this plan'}</button>
          {view.derived ? <button type="button" className="admin-btn" disabled={busy} onClick={clear}>Remove derivation</button> : null}
        </span>
      ) : !canManage ? <p style={{ fontSize: 12 }}>You can view this but not change it.</p> : null}
    </section>
  )
}
