'use client'

import { useRef, useState } from 'react'
import type { PromotionKind } from '@bedbanks/contracts'
import { apiErrorParts } from '@/lib/hotel-setup-ui'
import { blankPromotion, buildPromotionsInput, KIND_LABELS, type PromotionDraft } from '@/lib/promotions'
import { bulkApplyPromotion, type AdminRatePlan } from '@/lib/data'

const KINDS = Object.keys(KIND_LABELS) as PromotionKind[]
const note = { color: 'var(--c-3f565c)', fontSize: 11, margin: 0 } as const

/**
 * Hotel-wide offer (ADR 0067, F-09): one promotion added to the selected plans in one atomic, audited write. The API validates each plan's whole
 * promotion set and refuses the request, changing nothing, if any plan would be invalid. Retrying the same press is safe (idempotency key).
 */
export function HotelOfferPanel({ hotelId, plans, onApplied }: { hotelId: string; plans: AdminRatePlan[]; onApplied: () => void }) {
  const [draft, setDraft] = useState<PromotionDraft>(blankPromotion())
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false); const key = useRef<string | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string; details: string[] } | null>(null)
  const patch = (p: Partial<PromotionDraft>) => { key.current = null; setDraft((d) => ({ ...d, ...p })) }
  const toggle = (id: string) => { key.current = null; setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id])) }

  async function apply() {
    const built = buildPromotionsInput([draft], '')
    if (!built.input) { setMessage({ ok: false, text: 'Fix the promotion first.', details: built.problems }); return }
    if (selected.length === 0) { setMessage({ ok: false, text: 'Select at least one rate plan.', details: [] }); return }
    setBusy(true); setMessage(null); key.current ??= crypto.randomUUID()
    try {
      const result = await bulkApplyPromotion(hotelId, { idempotencyKey: key.current, ratePlanIds: selected, promotion: built.input.promotions[0]! })
      key.current = null; setSelected([]); setDraft(blankPromotion())
      setMessage({ ok: true, text: `"${result.promotion}" added to ${result.applied} rate plan(s)${result.replayed ? ' (already applied by an earlier press)' : ''}.`, details: [] }); onApplied()
    } catch (e) { const p = apiErrorParts(e, 'apply the offer'); setMessage({ ok: false, text: p.message, details: p.details }) } finally { setBusy(false) }
  }

  return (
    <section aria-label="Hotel-wide offer" data-testid="hotel-offer" style={{ borderTop: '1px solid var(--c-e6eef0)', paddingTop: 12, display: 'grid', gap: 8 }}>
      <h3 style={{ fontSize: 13, margin: 0 }}>Hotel-wide offer</h3>
      <p style={note}>Add one promotion to several plans at once. Each plan keeps its other promotions; nothing changes if any selected plan cannot take it.</p>
      <div className="admin-filter-bar">
        <select className="admin-filter-select" aria-label="Offer kind" value={draft.kind} onChange={(e) => patch({ ...blankPromotion(e.target.value as PromotionKind), name: draft.name, stayFrom: draft.stayFrom, stayTo: draft.stayTo, bookFrom: draft.bookFrom, bookTo: draft.bookTo })}>{KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}</select>
        <input className="admin-filter-select" aria-label="Offer name" placeholder="Name agents see" maxLength={80} value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
        {draft.kind !== 'FREE_NIGHTS' ? <input className="admin-filter-select" aria-label="Offer discount percent" inputMode="decimal" placeholder="Discount %" value={draft.percent} onChange={(e) => patch({ percent: e.target.value })} /> : null}
        {draft.kind === 'EARLY_BIRD' ? <input className="admin-filter-select" aria-label="Offer days ahead at least" inputMode="numeric" placeholder="Days ahead ≥" value={draft.minLeadDays} onChange={(e) => patch({ minLeadDays: e.target.value })} /> : null}
        {draft.kind === 'LAST_MINUTE' ? <input className="admin-filter-select" aria-label="Offer days ahead at most" inputMode="numeric" placeholder="Days ahead ≤" value={draft.maxLeadDays} onChange={(e) => patch({ maxLeadDays: e.target.value })} /> : null}
        {draft.kind === 'LONG_STAY' || draft.kind === 'FREE_NIGHTS' ? <input className="admin-filter-select" aria-label="Offer minimum nights" inputMode="numeric" placeholder="Min nights" value={draft.minNights} onChange={(e) => patch({ minNights: e.target.value })} /> : null}
        {draft.kind === 'FREE_NIGHTS' ? <input className="admin-filter-select" aria-label="Offer free nights" inputMode="numeric" placeholder="Free nights" value={draft.freeNights} onChange={(e) => patch({ freeNights: e.target.value })} /> : null}
        <input className="admin-filter-select" type="date" aria-label="Offer stay from" value={draft.stayFrom} onChange={(e) => patch({ stayFrom: e.target.value })} />
        <input className="admin-filter-select" type="date" aria-label="Offer stay to" value={draft.stayTo} onChange={(e) => patch({ stayTo: e.target.value })} />
        <label style={{ fontSize: 11 }}><input type="checkbox" checked={draft.combinable} onChange={(e) => patch({ combinable: e.target.checked })} /> Combinable</label>
        <label style={{ fontSize: 11 }}><input type="checkbox" checked={draft.partialStay} onChange={(e) => patch({ partialStay: e.target.checked })} /> Nights in window only</label>
        <label style={{ fontSize: 11 }}><input type="checkbox" checked={draft.roomOnly} onChange={(e) => patch({ roomOnly: e.target.checked })} /> Room rate only</label>
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 12 }}>
        <legend style={{ fontSize: 11, marginBottom: 4 }}>Rate plans on this page ({selected.length} selected)</legend>
        {plans.map((plan) => <label key={plan.id}><input type="checkbox" checked={selected.includes(plan.id)} onChange={() => toggle(plan.id)} /> {plan.code} <span style={{ color: 'var(--c-3f565c)' }}>({plan.status})</span></label>)}
      </fieldset>
      <div><button type="button" className="button primary" disabled={busy} onClick={() => void apply()}>{busy ? 'Applying…' : 'Add to selected plans'}</button></div>
      {message ? <div role={message.ok ? 'status' : 'alert'} className={message.ok ? undefined : 'admin-error'} style={{ fontSize: 12 }}><strong>{message.text}</strong>{message.details.length ? <ul>{message.details.map((d) => <li key={d}>{d}</li>)}</ul> : null}</div> : null}
    </section>
  )
}
