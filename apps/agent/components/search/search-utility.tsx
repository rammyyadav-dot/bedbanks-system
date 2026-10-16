'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { BadgePercent, ChevronDown, ChevronUp, Sparkles, X } from 'lucide-react'
import type { SmartSearchParseResponse } from '@bedbanks/contracts'
import { SMART_SEARCH_TEXT_MAX } from '@bedbanks/contracts'
import { parseSmartSearch } from '@/lib/api-client'
import { formatMarkupPercent, MAX_CLIENT_MARKUP_BP, parseMarkupPercent, stepMarkup } from '@/lib/client-markup'
import { guestMarketName } from '@/lib/guest-market'
import { formatCompactStay } from '@/lib/format'

/** Client markup (ADR 0065): a percentage the agent adds for their own client, applied to prices on screen only. Integer basis points. */
export function MarkupControl({ basisPoints, onChange }: { basisPoints: number; onChange: (basisPoints: number) => void }) {
  const [text, setText] = useState(basisPoints ? formatMarkupPercent(basisPoints) : '0')
  const [error, setError] = useState('')
  const id = useId()
  useEffect(() => { setText(basisPoints ? formatMarkupPercent(basisPoints) : '0') }, [basisPoints])
  const commit = (value: string) => {
    setText(value)
    const parsed = parseMarkupPercent(value)
    if (!parsed.ok) return setError(parsed.reason)
    setError(''); onChange(parsed.basisPoints)
  }
  const step = (direction: 1 | -1) => { setError(''); onChange(stepMarkup(basisPoints, direction)) }
  return <div className={`sb-markup${basisPoints > 0 ? ' is-set' : ''}`}>
    <BadgePercent size={20} aria-hidden="true" className="sb-field-icon" />
    <label htmlFor={`${id}-input`}>Set extra markup (%)</label>
    <div className="sb-markup-input">
      <input id={`${id}-input`} inputMode="decimal" value={text} aria-invalid={Boolean(error)} aria-describedby={`${id}-help`} onChange={(event) => commit(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); step(event.key === 'ArrowUp' ? 1 : -1) }
      }} />
      <span className="sb-markup-steps">
        <button type="button" aria-label="Increase markup by 1%" disabled={basisPoints >= MAX_CLIENT_MARKUP_BP} onClick={() => step(1)}><ChevronUp size={12} /></button>
        <button type="button" aria-label="Decrease markup by 1%" disabled={basisPoints <= 0} onClick={() => step(-1)}><ChevronDown size={12} /></button>
      </span>
      <span aria-hidden="true">%</span>
    </div>
    <small id={`${id}-help`} className={error ? 'is-error' : ''} role={error ? 'alert' : undefined}>{error || (basisPoints > 0 ? 'Client price shown; you pay agency price' : 'No markup: agency prices shown')}</small>
  </div>
}

const FIELD_LABEL: Record<SmartSearchParseResponse['unresolved'][number], string> = { destination: 'destination', dates: 'dates', occupancy: 'guests & rooms', stars: 'star rating', nationality: 'nationality' }

/**
 * Smart Search (ADR 0065): paste a client request; the server reads the fields and the agent applies them to the search bar.
 * The text is sent once for parsing and is not stored.
 */
export function SmartSearchControl({ tenantId, onApply }: { tenantId: string; onApply: (result: SmartSearchParseResponse, destination: SmartSearchParseResponse['destination']) => void }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<SmartSearchParseResponse | null>(null)
  const [destination, setDestination] = useState<SmartSearchParseResponse['destination']>(undefined)
  const id = useId()
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (open) area.current?.focus() }, [open])
  const read = async () => {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    setBusy(true); setError(''); setResult(null)
    try {
      const parsed = await parseSmartSearch(trimmed, tenantId)
      setResult(parsed); setDestination(parsed.destination)
    } catch (failure) {
      setError(failure instanceof Error && failure.message === 'Access denied' ? 'Smart Search is not available for your account.' : 'Smart Search could not read this request. Try again or fill in the fields.')
    } finally { setBusy(false) }
  }
  const found = result ? [
    destination && `${destination.type === 'city' ? destination.name : `${destination.name}, ${destination.cityName}`}`,
    result.checkIn && result.checkOut && `${formatCompactStay(result.checkIn, result.checkOut)} (${result.nights} night${result.nights === 1 ? '' : 's'})`,
    result.rooms && `${result.rooms.length} room${result.rooms.length === 1 ? '' : 's'} · ${result.rooms.reduce((n, r) => n + r.adults, 0)} adults${result.rooms.some((r) => r.childAges.length) ? ` · children aged ${result.rooms.flatMap((r) => r.childAges).join(', ')}` : ''}`,
    result.starRatings && `${result.starRatings.join(', ')}★`,
    result.nationality && `${guestMarketName(result.nationality)} guests`,
  ].filter(Boolean) as string[] : []
  const unresolved = result ? result.unresolved.filter((field) => !(field === 'destination' && destination)) : []
  return <div className={`sb-smart${open ? ' is-open' : ''}`}>
    <button type="button" className="sb-smart-trigger" aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => setOpen((value) => !value)}>
      <Sparkles size={20} aria-hidden="true" />
      <span><em>Smart Search</em><strong>Try Smart Search</strong><small>Type or paste a request</small></span>
    </button>
    <p className="sb-smart-hint">Paste a client email; we fill in the search.</p>
    {open && <div className="sb-smart-panel" id={`${id}-panel`} role="dialog" aria-label="Smart Search">
      <div className="sb-smart-panel-head"><strong>Paste your client’s request</strong><button type="button" aria-label="Close Smart Search" onClick={() => setOpen(false)}><X size={16} /></button></div>
      <textarea ref={area} value={text} maxLength={SMART_SEARCH_TEXT_MAX} rows={4} aria-label="Client request" placeholder="e.g. 5-star hotel in Dubai for 2 adults, 3 nights from next Friday, Indian guests" onChange={(event) => { setText(event.target.value); setResult(null) }} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void read() } }} />
      <div className="sb-smart-actions">
        <small>{text.length}/{SMART_SEARCH_TEXT_MAX} · read on the server, not stored</small>
        <button type="button" className="portal-secondary" disabled={!text.trim() || busy} aria-busy={busy} onClick={() => void read()}>{busy ? 'Reading…' : 'Read request'}</button>
      </div>
      {error && <p className="portal-field-error" role="alert">{error}</p>}
      {result && <div className="sb-smart-result" role="status">
        {found.length > 0 ? <ul>{found.map((line) => <li key={line}>{line}</li>)}</ul> : <p>Nothing could be read from this request.</p>}
        {!destination && result.alternatives.length > 0 && <div className="sb-smart-choices"><span>Which destination?</span>{result.alternatives.map((option) => <button key={`${option.type}:${option.id}`} type="button" onClick={() => setDestination(option)}>{option.type === 'city' ? option.name : `${option.name}, ${option.cityName}`}</button>)}</div>}
        {unresolved.length > 0 && <p className="sb-smart-kept">Not found, kept as you had it: {unresolved.map((field) => FIELD_LABEL[field]).join(', ')}.</p>}
        {result.notes.map((note) => <p key={note} className="sb-smart-note">{note}</p>)}
        <button type="button" className="portal-primary" disabled={found.length === 0} onClick={() => { onApply(result, destination); setOpen(false) }}>Apply to search</button>
      </div>}
    </div>}
  </div>
}
