'use client'

import { useEffect, useState } from 'react'
import { FormField } from '@/components/forms/FormField'
import { describeApiError } from '@/lib/api/describe-error'
import { useCan } from '@/lib/auth/capabilities'
import { blankLine, buildGuestPricesInput, draftFromLines, type GuestLineDraft } from '@/lib/guest-prices'
import { getGuestPrices, replaceGuestPrices } from '@/lib/data'

/**
 * Child and extra-adult prices of one rate plan (ADR 0057, S6): per night, per guest, on top of the nightly rate, which is for the plan's base adults.
 * A plan with no lines keeps the flat rule (adults plus children equal its occupancy). The API validates every line and is the authority.
 */
export function GuestPricesPanel({ ratePlanId }: { ratePlanId: string }) {
  const canManage = useCan()('supply.rates.manage')
  const [state, setState] = useState<{ currency: string; occupancy: number; updatedAt: string } | null>(null)
  const [drafts, setDrafts] = useState<GuestLineDraft[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = () => getGuestPrices(ratePlanId).then((loaded) => { setState({ currency: loaded.currency, occupancy: loaded.occupancy, updatedAt: loaded.updatedAt }); setDrafts(draftFromLines(loaded.lines)); setLoadError(null) }).catch((error) => setLoadError(describeApiError(error, 'load the guest prices')))
  useEffect(() => { void load() }, [ratePlanId])

  const patch = (index: number, change: Partial<GuestLineDraft>) => { setProblems([]); setMessage(null); setDrafts((cur) => cur.map((line, i) => (i === index ? { ...line, ...change } : line))) }

  async function save() {
    if (!state) return
    const built = buildGuestPricesInput(drafts, state.currency, state.updatedAt)
    setProblems(built.problems)
    if (!built.input) return
    setBusy(true); setMessage(null)
    try { const saved = await replaceGuestPrices(ratePlanId, built.input); setState({ currency: saved.currency, occupancy: saved.occupancy, updatedAt: saved.updatedAt }); setDrafts(draftFromLines(saved.lines)); setMessage({ kind: 'ok', text: saved.lines.length ? `Saved ${saved.lines.length} guest price line(s).` : 'Removed every guest price line: the plan sells its flat occupancy again.' }) }
    catch (error) { setMessage({ kind: 'error', text: describeApiError(error, 'save the guest prices') }) } finally { setBusy(false) }
  }

  if (loadError) return <p role="alert" style={{ color: '#a11d1d', fontSize: 12 }}>{loadError}</p>
  if (!state) return <p role="status" style={{ fontSize: 12 }}>Loading guest prices…</p>
  return (
    <section className="workspace-panel" style={{ maxWidth: 760, padding: 22, marginTop: 16 }} aria-label="Child and extra-adult prices">
      <h2 style={{ fontSize: 14, margin: '0 0 6px' }}>Children and extra adults</h2>
      <p style={{ margin: '0 0 10px', fontSize: 12, color: '#3f565c' }}>The nightly rate is for {state.occupancy} adult{state.occupancy === 1 ? '' : 's'}. {drafts.length === 0 ? 'With no lines below, the plan sells only a party of exactly that size, priced flat.' : 'Each child is priced per night by their age band, each adult beyond the base by the extra-adult line. A child no band covers is not sold. NET or SELL must match the nightly rate.'}</p>
      {drafts.map((line, index) => (
        <div key={index} data-testid="guest-line" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end', marginBottom: 6 }}>
          <FormField label="Guest"><select value={line.kind} onChange={(e) => patch(index, blankLineFor(e.target.value as GuestLineDraft['kind'], line))} disabled={!canManage}><option value="CHILD">Child by age</option><option value="EXTRA_ADULT">Extra adult</option></select></FormField>
          {line.kind === 'CHILD' ? (
            <>
              <FormField label="From age"><input inputMode="numeric" size={3} value={line.minAge} onChange={(e) => patch(index, { minAge: e.target.value })} disabled={!canManage} aria-label={`Line ${index + 1} from age`} /></FormField>
              <FormField label="To age"><input inputMode="numeric" size={3} value={line.maxAge} onChange={(e) => patch(index, { maxAge: e.target.value })} disabled={!canManage} aria-label={`Line ${index + 1} to age`} /></FormField>
            </>
          ) : null}
          <FormField label={`Per night (${state.currency})`}><input inputMode="decimal" size={9} value={line.amount} onChange={(e) => patch(index, { amount: e.target.value })} disabled={!canManage} aria-label={`Line ${index + 1} price per night`} placeholder="0 = free" /></FormField>
          <FormField label="Basis"><select value={line.basis} onChange={(e) => patch(index, { basis: e.target.value as GuestLineDraft['basis'] })} disabled={!canManage} aria-label={`Line ${index + 1} basis`}><option value="">Choose…</option><option value="SELL">SELL</option><option value="NET">NET</option></select></FormField>
          {canManage ? <button type="button" className="admin-btn" onClick={() => { setProblems([]); setDrafts((cur) => cur.filter((_, i) => i !== index)) }}>Remove</button> : null}
        </div>
      ))}
      {problems.length ? <ul role="alert" style={{ margin: '6px 0', paddingLeft: 16, fontSize: 12, color: '#a11d1d' }}>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul> : null}
      {message ? <p role={message.kind === 'error' ? 'alert' : 'status'} style={{ color: message.kind === 'error' ? '#a11d1d' : '#1f7a5a', fontSize: 12 }}>{message.text}</p> : null}
      {canManage ? (
        <span style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="admin-btn" onClick={() => { setProblems([]); setDrafts((cur) => [...cur, blankLine('CHILD')]) }}>Add child band</button>
          {!drafts.some((d) => d.kind === 'EXTRA_ADULT') ? <button type="button" className="admin-btn" onClick={() => { setProblems([]); setDrafts((cur) => [...cur, blankLine('EXTRA_ADULT')]) }}>Add extra-adult price</button> : null}
          <button type="button" className="admin-btn admin-btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save guest prices'}</button>
        </span>
      ) : <p style={{ fontSize: 12 }}>You can view these prices but not change them.</p>}
    </section>
  )
}

const blankLineFor = (kind: GuestLineDraft['kind'], current: GuestLineDraft): Partial<GuestLineDraft> => ({ kind, ...(kind === 'CHILD' ? { minAge: current.minAge || '0', maxAge: current.maxAge || '17' } : { minAge: '', maxAge: '' }) })
