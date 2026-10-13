'use client'

import { useEffect, useRef, useState } from 'react'
import type { PromotionKind } from '@bedbanks/contracts'
import { FormField } from '@/components/forms/FormField'
import { describeApiError } from '@/lib/api/describe-error'
import { useCan } from '@/lib/auth/capabilities'
import { KIND_LABELS, blankPromotion, buildPromotionsInput, draftFromPromotions, type PromotionDraft } from '@/lib/promotions'
import { getPromotions, replacePromotions } from '@/lib/data'

/**
 * Promotions of one rate plan (ADR 0058, S10a). A promotion is taken off each night's net before the markup; at most one applies to a stay (the one that
 * saves the buyer the most) and they never stack. Booking lead is counted in the hotel's calendar. The API validates every field and is the authority.
 */
export function PromotionsPanel({ ratePlanId }: { ratePlanId: string }) {
  const canManage = useCan()('supply.rates.manage')
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<PromotionDraft[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  // A load that finishes after the person has started editing must not overwrite their edits (the page can load twice in development, and a slow server answers late).
  const touched = useRef(false)

  const load = () => getPromotions(ratePlanId).then((loaded) => { if (touched.current) return; setUpdatedAt(loaded.updatedAt); setDrafts(draftFromPromotions(loaded.promotions)); setLoadError(null) }).catch((error) => setLoadError(describeApiError(error, 'load the promotions')))
  useEffect(() => { void load() }, [ratePlanId])

  const patch = (index: number, change: Partial<PromotionDraft>) => { touched.current = true; setProblems([]); setMessage(null); setDrafts((cur) => cur.map((row, i) => (i === index ? { ...row, ...change } : row))) }

  async function save() {
    if (!updatedAt) return
    const built = buildPromotionsInput(drafts, updatedAt)
    setProblems(built.problems)
    if (!built.input) return
    setBusy(true); setMessage(null)
    try { const saved = await replacePromotions(ratePlanId, built.input); touched.current = false; setUpdatedAt(saved.updatedAt); setDrafts(draftFromPromotions(saved.promotions)); setMessage({ kind: 'ok', text: 'Promotions saved. Any activation approval filed before this change is void.' }) }
    catch (error) { setMessage({ kind: 'error', text: describeApiError(error, 'save the promotions') }) } finally { setBusy(false) }
  }

  if (loadError) return <p role="alert" style={{ color: '#a11d1d', fontSize: 12 }}>{loadError}</p>
  if (updatedAt === null) return <p role="status" style={{ fontSize: 12 }}>Loading promotions…</p>
  return (
    <section className="workspace-panel" style={{ maxWidth: 760, padding: 22, marginTop: 16 }} aria-label="Promotions">
      <h2 style={{ fontSize: 14, margin: '0 0 6px' }}>Promotions</h2>
      <p style={{ margin: '0 0 10px', fontSize: 12, color: '#3f565c' }}>{drafts.length === 0 ? 'No promotions: the plan sells at its rate.' : 'Only one promotion applies to a stay: the one that saves the buyer the most. They never stack. The discount comes off the net before the markup.'}</p>
      {drafts.map((row, index) => (
        <div key={index} data-testid="promotion-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end', marginBottom: 8 }}>
          <FormField label="Kind"><select value={row.kind} onChange={(e) => patch(index, blankPromotionFor(e.target.value as PromotionKind, row))} disabled={!canManage}>{(Object.keys(KIND_LABELS) as PromotionKind[]).map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}</select></FormField>
          <FormField label="Name (agents see it)"><input value={row.name} maxLength={80} onChange={(e) => patch(index, { name: e.target.value })} disabled={!canManage} aria-label={`Promotion ${index + 1} name`} /></FormField>
          {row.kind !== 'FREE_NIGHTS' ? <FormField label="Discount %"><input inputMode="decimal" size={5} value={row.percent} onChange={(e) => patch(index, { percent: e.target.value })} disabled={!canManage} aria-label={`Promotion ${index + 1} discount percent`} /></FormField> : null}
          {row.kind === 'EARLY_BIRD' ? <FormField label="Booked at least (days ahead)"><input inputMode="numeric" size={4} value={row.minLeadDays} onChange={(e) => patch(index, { minLeadDays: e.target.value })} disabled={!canManage} aria-label={`Promotion ${index + 1} minimum days ahead`} /></FormField> : null}
          {row.kind === 'LAST_MINUTE' ? <FormField label="Booked at most (days ahead)"><input inputMode="numeric" size={4} value={row.maxLeadDays} onChange={(e) => patch(index, { maxLeadDays: e.target.value })} disabled={!canManage} aria-label={`Promotion ${index + 1} maximum days ahead`} /></FormField> : null}
          {row.kind === 'LONG_STAY' || row.kind === 'FREE_NIGHTS' ? <FormField label="Minimum nights"><input inputMode="numeric" size={4} value={row.minNights} onChange={(e) => patch(index, { minNights: e.target.value })} disabled={!canManage} aria-label={`Promotion ${index + 1} minimum nights`} /></FormField> : null}
          {row.kind === 'FREE_NIGHTS' ? <FormField label="Free nights"><input inputMode="numeric" size={4} value={row.freeNights} onChange={(e) => patch(index, { freeNights: e.target.value })} disabled={!canManage} aria-label={`Promotion ${index + 1} free nights`} /></FormField> : null}
          <FormField label="Book from"><input type="date" value={row.bookFrom} onChange={(e) => patch(index, { bookFrom: e.target.value })} disabled={!canManage} aria-label={`Promotion ${index + 1} book from`} /></FormField>
          <FormField label="Book to"><input type="date" value={row.bookTo} onChange={(e) => patch(index, { bookTo: e.target.value })} disabled={!canManage} aria-label={`Promotion ${index + 1} book to`} /></FormField>
          <FormField label="Stay from"><input type="date" value={row.stayFrom} onChange={(e) => patch(index, { stayFrom: e.target.value })} disabled={!canManage} aria-label={`Promotion ${index + 1} stay from`} /></FormField>
          <FormField label="Stay to"><input type="date" value={row.stayTo} onChange={(e) => patch(index, { stayTo: e.target.value })} disabled={!canManage} aria-label={`Promotion ${index + 1} stay to`} /></FormField>
          {canManage ? <button type="button" className="admin-btn" onClick={() => { touched.current = true; setProblems([]); setDrafts((cur) => cur.filter((_, i) => i !== index)) }}>Remove</button> : null}
        </div>
      ))}
      {problems.length ? <ul role="alert" style={{ margin: '6px 0', paddingLeft: 16, fontSize: 12, color: '#a11d1d' }}>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul> : null}
      {message ? <p role={message.kind === 'error' ? 'alert' : 'status'} style={{ color: message.kind === 'error' ? '#a11d1d' : '#1f7a5a', fontSize: 12 }}>{message.text}</p> : null}
      {canManage ? (
        <span style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="admin-btn" onClick={() => { touched.current = true; setProblems([]); setDrafts((cur) => [...cur, blankPromotion('EARLY_BIRD')]) }}>Add promotion</button>
          <button type="button" className="admin-btn admin-btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save promotions'}</button>
        </span>
      ) : <p style={{ fontSize: 12 }}>You can view these promotions but not change them.</p>}
    </section>
  )
}

/** Changing the kind keeps the name and windows and clears the fields that kind does not use, so a stale value is never sent. */
const blankPromotionFor = (kind: PromotionKind, current: PromotionDraft): Partial<PromotionDraft> => ({ ...blankPromotion(kind), name: current.name, bookFrom: current.bookFrom, bookTo: current.bookTo, stayFrom: current.stayFrom, stayTo: current.stayTo, percent: kind === 'FREE_NIGHTS' ? '' : current.percent })
