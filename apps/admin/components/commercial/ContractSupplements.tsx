'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { SUPPLEMENT_BASIS_LABELS, SUPPLEMENT_FREQUENCY_LABELS, type ContractSupplementTerm } from '@bedbanks/contracts'
import { describeApiError } from '@/lib/api/describe-error'
import { formatMinorUnits } from '@/lib/minor-units'
import { blankSupplement, describeSupplement, supplementFromForm, type SupplementForm } from '@/lib/supplements-ui'
import { createSupplement, deleteSupplement, getBoardBases, type AdminContractDetail, type BoardBasisRecord } from '@/lib/data'

const BASES = Object.keys(SUPPLEMENT_BASIS_LABELS) as Array<ContractSupplementTerm['basis']>
const FREQUENCIES = Object.keys(SUPPLEMENT_FREQUENCY_LABELS) as Array<ContractSupplementTerm['frequency']>

/**
 * Board and compulsory supplements of a contract (ADR 0067). Added to the price after any promotion and before the markup, for every plan of the
 * contract (BOARD: every plan sold on that board). Added and removed only while the terms are editable; an ACTIVE contract changes them by amendment.
 */
export function ContractSupplements({ contract, canManage, editable, onChanged }: { contract: AdminContractDetail; canManage: boolean; editable: boolean; onChanged: () => void }) {
  const canEdit = canManage && editable
  const [boards, setBoards] = useState<BoardBasisRecord[]>([])
  const [form, setForm] = useState<SupplementForm>(blankSupplement)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { getBoardBases().then(setBoards).catch(() => setBoards([])) }, [])
  const boardName = (id: string | null) => (id ? boards.find((b) => b.id === id)?.code ?? 'board' : undefined)
  const rows = contract.supplements ?? []

  async function run(work: () => Promise<unknown>, done: string) {
    setBusy(true); setMessage(null)
    try { await work(); setMessage(done); onChanged() } catch (error) { setMessage(describeApiError(error, 'save the supplement')) } finally { setBusy(false) }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const term = supplementFromForm(form, contract.settlementCurrency)
    if (typeof term === 'string') { setMessage(term); return }
    void run(() => createSupplement(contract.id, term), 'Supplement added.').then(() => setForm(blankSupplement))
  }

  return (
    <section className="workspace-panel" style={{ maxWidth: 760, padding: 22, marginTop: 16, display: 'grid', gap: 8 }} aria-label="Supplements">
      <h2 style={{ fontSize: 14, margin: 0 }}>Supplements</h2>
      <p style={{ fontSize: 11, color: '#3f565c', margin: 0 }}>Included in the price agents see, after any promotion and before the markup. A board supplement applies to the plans sold on that board; a compulsory one (a gala dinner) to every plan for the stay nights it names.</p>
      {rows.length === 0 ? <p style={{ fontSize: 12, margin: 0 }}>No supplement defined.</p> : (
        <ul style={{ fontSize: 12, margin: 0 }}>{rows.map((s) => (
          <li key={s.id}><strong>{s.kind === 'BOARD' ? 'Board' : 'Compulsory'}</strong> · {describeSupplement(s, formatMinorUnits, boardName(s.boardBasisId))}{canEdit ? <> <button type="button" className="admin-btn" disabled={busy} aria-label={`Remove supplement ${s.name}`} onClick={() => void run(() => deleteSupplement(contract.id, s.id), 'Supplement removed.')}>Remove</button></> : null}</li>
        ))}</ul>
      )}
      {canEdit ? (
        <form onSubmit={submit} className="admin-filter-bar" aria-label="Add supplement">
          <select className="admin-filter-select" aria-label="Supplement kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as SupplementForm['kind'] })}><option value="COMPULSORY">Compulsory</option><option value="BOARD">Board</option></select>
          <input className="admin-filter-select" aria-label="Supplement name" placeholder="Name (e.g. Gala dinner)" maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          {form.kind === 'BOARD' ? <select className="admin-filter-select" aria-label="Board priced" value={form.boardBasisId} onChange={(e) => setForm({ ...form, boardBasisId: e.target.value })} required><option value="">Board…</option>{boards.filter((b) => b.isActive).map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}</select> : null}
          <input className="admin-filter-select" aria-label={`Amount (${contract.settlementCurrency})`} inputMode="decimal" placeholder={`Amount (${contract.settlementCurrency})`} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
          <select className="admin-filter-select" aria-label="Charged" value={form.basis} onChange={(e) => setForm({ ...form, basis: e.target.value as SupplementForm['basis'] })}>{BASES.map((b) => <option key={b} value={b}>{SUPPLEMENT_BASIS_LABELS[b]}</option>)}</select>
          <select className="admin-filter-select" aria-label="Frequency" value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as SupplementForm['frequency'] })}>{FREQUENCIES.map((f) => <option key={f} value={f}>{SUPPLEMENT_FREQUENCY_LABELS[f]}</option>)}</select>
          <input className="admin-filter-select" type="date" aria-label="First stay night (optional)" value={form.stayFrom} onChange={(e) => setForm({ ...form, stayFrom: e.target.value })} />
          <input className="admin-filter-select" type="date" aria-label="Last stay night (optional)" value={form.stayTo} onChange={(e) => setForm({ ...form, stayTo: e.target.value })} />
          <button type="submit" className="admin-btn" disabled={busy}>Add supplement</button>
        </form>
      ) : canManage && !editable ? <p style={{ fontSize: 11, color: '#3f565c', margin: 0 }}>This contract is ACTIVE: change supplements through a policy amendment below.</p> : null}
      {message ? <p role="status" style={{ fontSize: 12, margin: 0 }}>{message}</p> : null}
    </section>
  )
}
