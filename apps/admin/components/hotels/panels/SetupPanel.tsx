'use client'

import { useMemo, useRef, useState } from 'react'
import {
  HOTEL_CONTACT_KINDS, HOTEL_PROFILE_STATUSES, HOTEL_PROPERTY_TYPES, KNOWN_EXTERNAL_SCHEMES,
  type HotelContactKind, type HotelOwnerCandidate, type HotelProfileStatus, type HotelSetupSave, type HotelSetupView,
} from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Completeness } from '../Completeness'
import { apiErrorParts } from '@/lib/hotel-setup-ui'
import { approveHotelPublication, cancelHotelPublication, changeHotelStatus, executeHotelPublication, getHotelSetup, getOwnerCandidates, rejectHotelPublication, requestHotelPublication, saveHotelSetup } from '@/lib/data/hotel-setup'
import { useCan } from '@/lib/auth/capabilities'
import { when } from '@/components/ops/ops-ui'

type Form = {
  name: string; propertyType: string; legalName: string; chainName: string; brandName: string
  countryCode: string; city: string; area: string; address: string; postalCode: string; latitude: string; longitude: string; timeZone: string
  starRating: string; starSource: string; starVerified: boolean
  shortDescription: string; fullDescription: string; languages: string
  checkInTime: string; checkOutTime: string; operationalNotes: string
  contacts: Record<HotelContactKind, { name: string; email: string; phone: string }>
  sourceSystem: string; ownerUserId: string
  identifiers: Array<{ scheme: string; value: string }>
}

const blank = (v: string | null | undefined) => v ?? ''
function toForm(s: HotelSetupView): Form {
  const contacts = Object.fromEntries(HOTEL_CONTACT_KINDS.map((k) => [k, { name: blank(s.contacts?.[k]?.name), email: blank(s.contacts?.[k]?.email), phone: blank(s.contacts?.[k]?.phone) }])) as Form['contacts']
  return {
    name: s.identity.name, propertyType: s.identity.propertyType, legalName: blank(s.identity.legalName), chainName: blank(s.identity.chainName), brandName: blank(s.identity.brandName),
    countryCode: s.location.countryCode, city: s.location.city, area: blank(s.location.area), address: blank(s.location.address), postalCode: blank(s.location.postalCode), latitude: blank(s.location.latitude), longitude: blank(s.location.longitude), timeZone: s.location.timeZone,
    starRating: s.classification.starRating === null ? '' : String(s.classification.starRating), starSource: blank(s.classification.source), starVerified: s.classification.verified,
    shortDescription: blank(s.content.shortDescription), fullDescription: blank(s.content.fullDescription), languages: s.content.languages.join(', '),
    checkInTime: blank(s.operations.checkInTime), checkOutTime: blank(s.operations.checkOutTime), operationalNotes: blank(s.operations.notes),
    contacts, sourceSystem: blank(s.governance.sourceSystem), ownerUserId: blank(s.governance.ownerUserId), identifiers: s.identity.externalIdentifiers.map((i) => ({ scheme: i.scheme, value: i.value })),
  }
}

const nul = (v: string) => (v.trim() === '' ? null : v.trim())
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Only the fields the operator changed are sent; an untouched field stays exactly as stored. */
function diff(initial: Form, now: Form, canContacts: boolean): Omit<HotelSetupSave, 'idempotencyKey' | 'expectedToken'> {
  const out: Record<string, unknown> = {}
  const text = (key: keyof Form, apiKey: string, nullable: boolean) => { if (initial[key] !== now[key]) out[apiKey] = nullable ? nul(now[key] as string) : (now[key] as string).trim() }
  text('name', 'name', false); text('propertyType', 'propertyType', false); text('legalName', 'legalName', true); text('chainName', 'chainName', true); text('brandName', 'brandName', true)
  text('countryCode', 'countryCode', false); text('city', 'city', false); text('area', 'area', true); text('address', 'address', true); text('postalCode', 'postalCode', true)
  text('latitude', 'latitude', true); text('longitude', 'longitude', true); text('timeZone', 'timeZone', false)
  if (initial.starRating !== now.starRating) out.starRating = now.starRating === '' ? null : Number(now.starRating)
  text('starSource', 'starSource', true)
  if (initial.starVerified !== now.starVerified) out.starVerified = now.starVerified
  text('shortDescription', 'shortDescription', true); text('fullDescription', 'fullDescription', true); text('operationalNotes', 'operationalNotes', true)
  if (initial.languages !== now.languages) out.languages = now.languages.split(',').map((l) => l.trim()).filter(Boolean)
  text('checkInTime', 'checkInTime', true); text('checkOutTime', 'checkOutTime', true); text('sourceSystem', 'sourceSystem', true); text('ownerUserId', 'ownerUserId', true)
  if (canContacts && !same(initial.contacts, now.contacts)) out.contacts = Object.fromEntries(HOTEL_CONTACT_KINDS.map((k) => [k, { name: nul(now.contacts[k].name), email: nul(now.contacts[k].email), phone: nul(now.contacts[k].phone) }]))
  if (!same(initial.identifiers, now.identifiers)) out.externalIdentifiers = now.identifiers.filter((i) => i.scheme.trim() || i.value.trim()).map((i) => ({ scheme: i.scheme.trim(), value: i.value.trim() }))
  return out as never
}

const field = { display: 'grid', gap: 2, fontSize: 12, color: '#17333e' } as const
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 } as const
const note = { color: '#3f565c', fontSize: 11, margin: 0 } as const

const personLabel = (p: { name: string | null; email: string }) => (p.name ? `${p.name} (${p.email})` : p.email)

/** Searches tenant members through the API; the selected owner is validated again server-side as a member of this tenant. */
function OwnerPicker({ hotelId, value, stored, readOnly, onChange }: { hotelId: string; value: string; stored: HotelSetupView['governance']['owner']; readOnly: boolean; onChange: (v: string) => void }) {
  const [search, setSearch] = useState('')
  const [options, setOptions] = useState<HotelOwnerCandidate[] | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  const find = async () => {
    setState('loading')
    try { setOptions(await getOwnerCandidates(hotelId, search)); setState('idle') } catch { setOptions(null); setState('error') }
  }
  const current = options?.find((o) => o.userId === value) ?? (stored && stored.userId === value ? stored : null)
  return (
    <div style={{ ...field, gridColumn: '1 / -1' }} data-testid="owner-picker">
      <span>Owner</span>
      <span data-testid="owner-current">{value ? (current ? personLabel(current) : 'Selected member') : 'Not set'}</span>
      {!readOnly && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="input-wrap" aria-label="Search members" placeholder="Search members by name or e-mail" value={search} maxLength={64} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void find() } }} />
          <button type="button" className="admin-btn" onClick={() => void find()} disabled={state === 'loading'} data-testid="owner-search">{state === 'loading' ? 'Searching…' : 'Find'}</button>
          {value && <button type="button" className="admin-btn" onClick={() => onChange('')} data-testid="owner-clear">Clear owner</button>}
        </div>
      )}
      {state === 'error' && <span role="alert" style={{ ...note, color: '#9a1c1c' }}>Members could not be loaded. You may lack permission to list members.</span>}
      {options && (options.length === 0
        ? <span style={note} data-testid="owner-empty">No members match.</span>
        : <select className="input-wrap" aria-label="Choose owner" size={Math.min(options.length, 6)} value={value} onChange={(e) => onChange(e.target.value)} data-testid="owner-options">{options.map((o) => <option key={o.userId} value={o.userId}>{personLabel(o)}</option>)}</select>)}
      <span style={note}>The owner is an internal contact for this hotel profile. It grants no access and changes no permissions.</span>
    </div>
  )
}

type Flash = { kind: 'save' | 'status'; text: string; requestId: string | null }

/** The form is re-keyed by the stored concurrency token after every successful change, so the confirmation lives here and survives that remount. */
export function SetupPanel({ hotelId, onChanged }: { hotelId: string; onChanged: () => void }) {
  const [version, setVersion] = useState(0)
  const [flash, setFlash] = useState<Flash | null>(null)
  const { state, reload } = useOpsQuery(() => getHotelSetup(hotelId), [hotelId, version])
  return (
    <OpsState state={state} onRetry={reload}>
      {(setup) => (
        <>
          {flash && (
            <div role="status" data-testid={flash.kind === 'save' ? 'setup-notice' : 'status-notice'} className="workspace-panel" style={{ padding: 12, marginBottom: 12 }}>
              <strong>{flash.text}</strong>
              {flash.requestId && <div style={note}>Request id: <code data-testid="setup-request-id">{flash.requestId}</code></div>}
            </div>
          )}
          <SetupForm key={`${setup.hotelId}:${setup.concurrencyToken}`} hotelId={hotelId} setup={setup} onSaved={(f) => { setFlash(f); setVersion((v) => v + 1); onChanged() }} onReload={() => { setFlash(null); setVersion((v) => v + 1) }} />
        </>
      )}
    </OpsState>
  )
}

function SetupForm({ hotelId, setup, onSaved, onReload }: { hotelId: string; setup: HotelSetupView; onSaved: (flash: Flash) => void; onReload: () => void }) {
  const can = useCan()
  const canManage = can('supply.hotels.manage')
  const initial = useMemo(() => toForm(setup), [setup])
  const [form, setForm] = useState<Form>(initial)
  const [token, setToken] = useState(setup.concurrencyToken)
  const [busy, setBusy] = useState(false); const inFlight = useRef(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string; details: string[]; requestId: string | null; stale?: boolean } | null>(null)
  const pendingKey = useRef<string | null>(null)
  const changes = useMemo(() => diff(initial, form, setup.contacts !== null), [initial, form, setup.contacts])
  const dirty = Object.keys(changes).length > 0
  const set = <K extends keyof Form>(key: K, value: Form[K]) => { pendingKey.current = null; setForm((f) => ({ ...f, [key]: value })) }
  const ro = !canManage

  async function save() {
    if (inFlight.current || !dirty || ro) return
    inFlight.current = true; setBusy(true); setNotice(null)
    pendingKey.current ??= crypto.randomUUID()
    try {
      const { data, requestId } = await saveHotelSetup(hotelId, { ...changes, idempotencyKey: pendingKey.current, expectedToken: token })
      pendingKey.current = null
      onSaved({ kind: 'save', text: data.replayed ? 'This change was already saved.' : 'Saved. The values below are what the server stored.', requestId: data.auditRequestId || requestId })
    } catch (error) {
      const p = apiErrorParts(error, 'save the hotel setup')
      setToken(token)
      setNotice({ tone: 'bad', text: p.message, details: p.details, requestId: p.requestId, stale: p.code === 'HOTEL_SETUP_STALE' })
    } finally { inFlight.current = false; setBusy(false) }
  }

  const input = (key: keyof Form, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label style={field}>{label}<input className="input-wrap" value={form[key] as string} onChange={(e) => set(key, e.target.value as never)} readOnly={ro} {...props} /></label>
  )
  const area = (key: keyof Form, label: string, max: number) => (
    <label style={{ ...field, gridColumn: '1 / -1' }}>{label}<textarea className="input-wrap" rows={3} maxLength={max} value={form[key] as string} onChange={(e) => set(key, e.target.value as never)} readOnly={ro} /></label>
  )
  const section = (title: string, children: React.ReactNode, help?: string) => (
    <fieldset className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 10, border: '1px solid #e6eef0', margin: 0 }}>
      <legend style={{ fontSize: 14, fontWeight: 600, padding: '0 6px' }}>{title}</legend>
      {help && <p style={note}>{help}</p>}
      <div style={grid}>{children}</div>
    </fieldset>
  )
  const types = Array.from(new Set([...HOTEL_PROPERTY_TYPES as readonly string[], form.propertyType]))

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="workspace-panel" style={{ padding: 18 }}><Completeness completeness={setup.completeness} hotelId={hotelId} /></div>
      <form aria-label="Hotel setup" onSubmit={(e) => { e.preventDefault(); void save() }} style={{ display: 'grid', gap: 16 }} data-testid="setup-form">
        {section('Identity', <>
          {input('name', 'Hotel name', { maxLength: 160, required: true })}
          <label style={field}>Property type<select className="input-wrap" value={form.propertyType} onChange={(e) => set('propertyType', e.target.value)} disabled={ro}>{types.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
          {input('legalName', 'Legal name', { maxLength: 200 })}
          {input('chainName', 'Chain', { maxLength: 120 })}
          {input('brandName', 'Brand', { maxLength: 120 })}
          <div style={{ ...field, gridColumn: '1 / -1' }}>
            <span>Canonical fBeds hotel ID (immutable)</span><code data-testid="canonical-id">{setup.hotelId}</code>
            {setup.identity.code && <span style={note}>Legacy code: <code>{setup.identity.code}</code></span>}
          </div>
          <div style={{ gridColumn: '1 / -1', display: 'grid', gap: 6 }} data-testid="external-identifiers">
            <span style={{ fontSize: 12 }}>External identifiers (stored apart from the canonical ID; one per scheme, unique per tenant)</span>
            {form.identifiers.map((row, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
                <label style={field}>Scheme<input className="input-wrap" list="known-schemes" value={row.scheme} readOnly={ro} onChange={(e) => set('identifiers', form.identifiers.map((r, j) => (j === i ? { ...r, scheme: e.target.value.toUpperCase() } : r)))} maxLength={32} /></label>
                <label style={field}>Value<input className="input-wrap" value={row.value} readOnly={ro} onChange={(e) => set('identifiers', form.identifiers.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))} maxLength={80} /></label>
                {!ro && <button type="button" className="admin-btn" onClick={() => set('identifiers', form.identifiers.filter((_, j) => j !== i))}>Remove</button>}
              </div>
            ))}
            <datalist id="known-schemes">{KNOWN_EXTERNAL_SCHEMES.map((s) => <option key={s} value={s} />)}</datalist>
            {!ro && form.identifiers.length < 10 && <div><button type="button" className="admin-btn" onClick={() => set('identifiers', [...form.identifiers, { scheme: 'GIATA', value: '' }])}>Add identifier</button></div>}
          </div>
        </>)}
        {section('Location', <>
          {input('countryCode', 'Country (ISO-2)', { maxLength: 2, required: true })}
          {input('city', 'City', { maxLength: 120, required: true })}
          {input('area', 'Area', { maxLength: 120 })}
          {input('address', 'Street address', { maxLength: 300 })}
          {input('postalCode', 'Postal code', { maxLength: 20 })}
          {input('latitude', 'Latitude', { inputMode: 'decimal', placeholder: '25.197200' })}
          {input('longitude', 'Longitude', { inputMode: 'decimal', placeholder: '55.274400' })}
          {input('timeZone', 'IANA time zone', { maxLength: 64, required: true, placeholder: 'Asia/Dubai' })}
        </>, 'Release and cancellation deadlines use this time zone.')}
        {section('Classification', <>
          <label style={field}>Star category<select className="input-wrap" value={form.starRating} onChange={(e) => set('starRating', e.target.value)} disabled={ro}><option value="">Unrated</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} star{n === 1 ? '' : 's'}</option>)}</select></label>
          {input('starSource', 'Source of the category', { maxLength: 120, placeholder: 'For example the national tourism register' })}
          <label style={{ ...field, gridAutoFlow: 'column', justifyContent: 'start', alignItems: 'center', gap: 8 }}><input type="checkbox" checked={form.starVerified} onChange={(e) => set('starVerified', e.target.checked)} disabled={ro} /> Category verified</label>
          <p style={{ ...note, gridColumn: '1 / -1' }}>{setup.classification.verified ? `Verified ${when(setup.classification.verifiedAt ?? '')}.` : 'Not verified.'} Changing the category clears its verification until it is verified again.</p>
        </>)}
        {section('Content', <>
          {area('shortDescription', 'Short description (max 500)', 500)}
          {area('fullDescription', 'Full description (max 4000)', 4000)}
          {input('languages', 'Content languages (ISO 639-1, comma separated)', { placeholder: 'en, ar' })}
        </>)}
        {section('Operations', <>
          {input('checkInTime', 'Check-in time (hotel local)', { type: 'time' })}
          {input('checkOutTime', 'Check-out time (hotel local)', { type: 'time' })}
          {area('operationalNotes', 'Operational notes (max 2000)', 2000)}
        </>)}
        {setup.contacts === null
          ? <div className="workspace-panel" style={{ padding: 18 }} data-testid="contacts-hidden"><strong>Contacts</strong><p style={note}>Private contacts are visible only to people who can manage hotels.</p></div>
          : section('Contacts (private)', <>
            {HOTEL_CONTACT_KINDS.map((k) => (
              <div key={k} style={{ display: 'grid', gap: 6 }}>
                <strong style={{ fontSize: 12, textTransform: 'capitalize' }}>{k}</strong>
                {(['name', 'email', 'phone'] as const).map((f) => (
                  <label key={f} style={field}><span style={{ textTransform: 'capitalize' }}>{k} {f}</span><input className="input-wrap" value={form.contacts[k][f]} readOnly={ro} maxLength={f === 'email' ? 254 : 120} onChange={(e) => set('contacts', { ...form.contacts, [k]: { ...form.contacts[k], [f]: e.target.value } })} /></label>
                ))}
              </div>
            ))}
          </>, 'Never shown to Agents, the Website or suppliers. Do not enter guest details.')}
        <p style={note} data-testid="policies-moved">Hotel policies (children, extra beds, pets, accessibility, local charges) are edited on the Policies tab, apart from rate-specific cancellation terms. Amenities and images have their own tabs.</p>
        {section('Governance', <>
          {input('sourceSystem', 'Content source', { maxLength: 80 })}
          <OwnerPicker hotelId={hotelId} value={form.ownerUserId} stored={setup.governance.owner} readOnly={ro} onChange={(v) => set('ownerUserId', v)} />
          <div style={field}><span>Last saved</span><span>{when(setup.governance.updatedAt)}{setup.governance.updatedById ? <> by <code>{setup.governance.updatedById}</code></> : null}</span></div>
        </>)}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', position: 'sticky', bottom: 0, background: '#fff', padding: '8px 0' }}>
          {canManage ? <button type="submit" className="button primary" disabled={busy || !dirty} data-testid="setup-save">{busy ? 'Saving…' : 'Save changes'}</button> : <span style={note}>You can view this setup but not change it.</span>}
          {dirty && <button type="button" className="admin-btn" disabled={busy} onClick={() => { setForm(initial); setNotice(null); pendingKey.current = null }}>Discard edits</button>}
          {dirty && <span style={note}>{Object.keys(changes).length} field{Object.keys(changes).length === 1 ? '' : 's'} changed</span>}
        </div>
        {notice && (
          <div role="alert" data-testid="setup-error" className="admin-error" style={{ padding: 12 }}>
            <strong>{notice.text}</strong>
            {notice.details.length > 0 && <ul>{notice.details.map((d) => <li key={d}>{d}</li>)}</ul>}
            {notice.requestId && <div style={note}>Request id: <code data-testid="setup-request-id">{notice.requestId}</code></div>}
            {notice.stale && <button type="button" className="admin-btn" onClick={onReload}>Load the latest version (discards your edits)</button>}
          </div>
        )}
      </form>
      {canManage && <PublicationControl hotelId={hotelId} setup={setup} onDone={onSaved} />}
      {canManage && <StatusControl hotelId={hotelId} setup={setup} token={setup.concurrencyToken} onDone={onSaved} />}
    </div>
  )
}

function StatusControl({ hotelId, setup, token, onDone }: { hotelId: string; setup: HotelSetupView; token: string; onDone: (flash: Flash) => void }) {
  const [to, setTo] = useState<HotelProfileStatus>(setup.governance.status === 'COMPLETE' ? 'SUSPENDED' : 'DRAFT')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false); const inFlight = useRef(false)
  const key = useRef<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string; requestId: string | null } | null>(null)
  async function submit() {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setNotice(null); key.current ??= crypto.randomUUID()
    try {
      const { data, requestId } = await changeHotelStatus(hotelId, { idempotencyKey: key.current, expectedToken: token, to, reason: reason.trim() })
      key.current = null; setReason('')
      onDone({ kind: 'status', text: `Status is now ${data.setup.governance.status}.`, requestId: data.auditRequestId || requestId })
    } catch (error) { const p = apiErrorParts(error, 'change the status'); setNotice({ tone: 'bad', text: [p.message, ...p.details].join(' '), requestId: p.requestId }) } finally { inFlight.current = false; setBusy(false) }
  }
  return (
    <form className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 10 }} aria-label="Profile approval" data-testid="status-form" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <h2 style={{ fontSize: 14, margin: 0 }}>Profile approval</h2>
      <p style={note}>Current status: <strong data-testid="profile-status">{setup.governance.status}</strong>{setup.governance.approvedAt ? ` · approved ${when(setup.governance.approvedAt)}` : ''}. Publishing needs a second approver (see Publication). Publishing makes the hotel eligible for the Agent catalogue. It does not enable booking, payment or supplier access; commercial readiness is assessed separately. Withdrawing or suspending a hotel takes effect at once.</p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
        <label style={field}>Change to<select className="input-wrap" value={to} onChange={(e) => { key.current = null; setTo(e.target.value as HotelProfileStatus) }}>{HOTEL_PROFILE_STATUSES.filter((s) => s !== setup.governance.status && s !== 'COMPLETE').map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
        <label style={{ ...field, minWidth: 260 }}>Reason (required)<input className="input-wrap" value={reason} maxLength={500} onChange={(e) => { key.current = null; setReason(e.target.value) }} /></label>
        <button type="submit" className="button primary" disabled={busy || reason.trim().length < 3}>{busy ? 'Applying…' : 'Apply status'}</button>
      </div>
      {notice && <p role={notice.tone === 'bad' ? 'alert' : 'status'} data-testid="status-notice" style={{ margin: 0, color: notice.tone === 'bad' ? '#a11d1d' : '#0b6b55' }}>{notice.text}{notice.requestId ? ` Request id: ${notice.requestId}` : ''}</p>}
    </form>
  )
}

/** Maker-checker publication (ADR 0022): request, a different manager approves, then apply. The API enforces every rule; this only offers what the caller may do. */
function PublicationControl({ hotelId, setup, onDone }: { hotelId: string; setup: HotelSetupView; onDone: (flash: Flash) => void }) {
  const open = setup.publication ?? null
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false); const inFlight = useRef(false)
  const requestKey = useRef<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const unmet = setup.completeness.requirements.filter((r) => !r.met)
  if (setup.governance.status === 'COMPLETE') return null
  async function run(label: string, call: (key: string) => ReturnType<typeof requestHotelPublication>, done: string, reuseKey = false) {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setNotice(null)
    if (reuseKey) requestKey.current ??= crypto.randomUUID()
    try {
      const { requestId } = await call(requestKey.current ?? '')
      if (reuseKey) requestKey.current = null
      setReason('')
      onDone({ kind: 'status', text: done, requestId: requestId || null })
    } catch (error) { const p = apiErrorParts(error, label); setNotice([p.message, ...p.details].join(' ') + (p.requestId ? ` Request id: ${p.requestId}` : '')) } finally { inFlight.current = false; setBusy(false) }
  }
  const text = reason.trim()
  return (
    <section className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 10 }} aria-label="Publication" data-testid="publication">
      <h2 style={{ fontSize: 14, margin: 0 }}>Publication</h2>
      {!open && (
        <>
          <p style={note}>Publishing needs two people: you request it, then a different hotel manager approves it, then it is applied. The request is tied to the version you reviewed; any edit afterwards means a new request.</p>
          {unmet.length > 0 && <p role="note" style={{ ...note, color: '#8a1c1c' }} data-testid="publication-blocked">A request cannot be made until: {unmet.map((r) => r.label).join('; ')}.</p>}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
            <label style={{ ...field, minWidth: 260 }}>Reason (required)<input className="input-wrap" value={reason} maxLength={500} onChange={(e) => { requestKey.current = null; setReason(e.target.value) }} /></label>
            <button type="button" className="button primary" data-testid="publication-request" disabled={busy || unmet.length > 0 || text.length < 3}
              onClick={() => void run('request publication', (k) => requestHotelPublication(hotelId, { requestId: k, expectedToken: setup.concurrencyToken, reason: text }), 'Publication requested. A different manager must approve it.', true)}>{busy ? 'Requesting…' : 'Request publication'}</button>
          </div>
        </>
      )}
      {open && (
        <>
          <p style={note} data-testid="publication-state">Publication request: <strong>{open.status}</strong>. Requested by <code>{open.requestedById}</code>{open.decidedById ? <>, decided by <code>{open.decidedById}</code></> : null}. Reason: {open.reason}</p>
          {open.changedSinceRequest && <p role="alert" style={{ ...note, color: '#8a1c1c' }}>The hotel was edited after this request was made, so it cannot be approved or applied. {open.canCancel ? 'Withdraw it and make a new request.' : 'Reject it so a new request can be made.'}</p>}
          {open.canDecide && (
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
              <label style={{ ...field, minWidth: 260 }}>Decision reason (required)<input className="input-wrap" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></label>
              <button type="button" className="button primary" data-testid="publication-approve" disabled={busy || text.length < 3 || open.changedSinceRequest} onClick={() => void run('approve publication', () => approveHotelPublication(hotelId, open.id, { reason: text }), 'Publication approved. It is applied when someone presses Publish now.')}>Approve</button>
              <button type="button" className="admin-btn" data-testid="publication-reject" disabled={busy || text.length < 3} onClick={() => void run('reject publication', () => rejectHotelPublication(hotelId, open.id, { reason: text }), 'Publication request rejected.')}>Reject</button>
            </div>
          )}
          {open.canCancel && <div><button type="button" className="admin-btn" data-testid="publication-cancel" disabled={busy} onClick={() => void run('withdraw the request', () => cancelHotelPublication(hotelId, open.id), 'Publication request withdrawn.')}>Withdraw request</button></div>}
          {open.canExecute && <div><button type="button" className="button primary" data-testid="publication-execute" disabled={busy || open.changedSinceRequest} onClick={() => void run('publish', () => executeHotelPublication(hotelId, open.id), 'Status is now COMPLETE.')}>Publish now</button></div>}
          {!open.canDecide && !open.canCancel && !open.canExecute && <p style={note}>Waiting for another manager.</p>}
        </>
      )}
      {notice && <p role="alert" data-testid="publication-notice" style={{ margin: 0, color: '#a11d1d' }}>{notice}</p>}
    </section>
  )
}
