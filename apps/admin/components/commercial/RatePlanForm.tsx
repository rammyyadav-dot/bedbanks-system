'use client'

import { useEffect, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { PageHeader } from '@/components/common/PageHeader'
import { FormField } from '@/components/forms/FormField'
import { ErrorState } from '@/components/common/ErrorState'
import { LoadingState } from '@/components/common/LoadingState'
import { describeApiError } from '@/lib/api/describe-error'
import { useCan } from '@/lib/auth/capabilities'
import {
  createRatePlan, getBoardBases, getContracts, getHotels, getRatePlan, getRoomsByHotel, updateRatePlan,
  type AdminContract, type AdminRatePlan, type BoardBasisRecord, type HotelRecord, type RoomTypeRecord,
} from '@/lib/data'

const PLAN_STATUSES = ['DRAFT', 'ACTIVE', 'SUSPENDED', 'EXPIRED'] as const
interface FormState { contractId: string; hotelId: string; roomTypeId: string; boardBasisId: string; code: string; status: string; currency: string; occupancy: string; refundable: boolean; taxesIncluded: boolean; feesIncluded: boolean; minStay: string; maxStay: string; releaseDays: string }
const blank: FormState = { contractId: '', hotelId: '', roomTypeId: '', boardBasisId: '', code: '', status: 'DRAFT', currency: 'AED', occupancy: '2', refundable: true, taxesIncluded: false, feesIncluded: false, minStay: '1', maxStay: '', releaseDays: '0' }
const wholeNumber = (value: string) => /^\d+$/.test(value.trim()) ? Number(value) : null

export function RatePlanForm({ ratePlanId }: { ratePlanId?: string }) {
  const router = useRouter()
  const can = useCan()
  const editing = Boolean(ratePlanId)
  const canManage = can('supply.rates.manage')
  const [form, setForm] = useState<FormState>(blank)
  const [contracts, setContracts] = useState<AdminContract[]>([])
  const [hotels, setHotels] = useState<HotelRecord[]>([])
  const [rooms, setRooms] = useState<RoomTypeRecord[]>([])
  const [boards, setBoards] = useState<BoardBasisRecord[]>([])
  const [plan, setPlan] = useState<AdminRatePlan | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }))

  useEffect(() => {
    let active = true
    Promise.all([getContracts(), getHotels(), getBoardBases(), ratePlanId ? getRatePlan(ratePlanId) : Promise.resolve(null)])
      .then(async ([contractList, hotelList, boardList, existing]) => {
        if (!active) return
        setContracts(contractList); setHotels(hotelList); setBoards(boardList); setPlan(existing)
        if (existing) {
          const roomList = await getRoomsByHotel(existing.roomType.hotel.id) as RoomTypeRecord[]
          if (!active) return
          setRooms(roomList)
          setForm({ contractId: existing.contractId, hotelId: existing.roomType.hotel.id, roomTypeId: existing.roomTypeId, boardBasisId: existing.boardBasisId, code: existing.code, status: existing.status, currency: existing.currency, occupancy: String(existing.occupancy), refundable: existing.refundable, taxesIncluded: existing.taxesIncluded, feesIncluded: existing.feesIncluded, minStay: String(existing.minStay), maxStay: existing.maxStay == null ? '' : String(existing.maxStay), releaseDays: String(existing.releaseDays) })
        }
      })
      .catch((error) => { if (active) setLoadError(describeApiError(error, 'load rate plan data')) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [ratePlanId])

  // A contract bound to a hotel mapping fixes the hotel; otherwise the operator chooses it.
  const selectedContract = contracts.find((contract) => contract.id === form.contractId)
  const boundHotelId = selectedContract?.supplierHotelMapping?.hotelId
  async function chooseHotel(hotelId: string) {
    setForm((current) => ({ ...current, hotelId, roomTypeId: '' }))
    setRooms([])
    if (!hotelId) return
    try { setRooms(await getRoomsByHotel(hotelId) as RoomTypeRecord[]) } catch (error) { setMessage({ kind: 'error', text: describeApiError(error, 'load rooms') }) }
  }
  function chooseContract(contractId: string) {
    const bound = contracts.find((contract) => contract.id === contractId)
    setForm((current) => ({ ...current, contractId, currency: bound?.settlementCurrency ?? current.currency }))
    const hotelId = bound?.supplierHotelMapping?.hotelId
    if (hotelId && hotelId !== form.hotelId) void chooseHotel(hotelId)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setMessage(null)
    const occupancy = wholeNumber(form.occupancy), minStay = wholeNumber(form.minStay), releaseDays = wholeNumber(form.releaseDays)
    const maxStay = form.maxStay.trim() === '' ? null : wholeNumber(form.maxStay)
    if (!form.contractId || !form.roomTypeId || !form.boardBasisId || !form.code.trim()) return setMessage({ kind: 'error', text: 'Contract, room, board basis and code are required.' })
    if (occupancy === null || occupancy < 1 || minStay === null || minStay < 1 || releaseDays === null || (form.maxStay.trim() !== '' && maxStay === null)) return setMessage({ kind: 'error', text: 'Occupancy and minimum stay must be at least 1; stay and release values must be whole numbers.' })
    if (maxStay !== null && maxStay < minStay) return setMessage({ kind: 'error', text: 'Maximum stay cannot be below minimum stay.' })
    if (!/^[A-Za-z]{3}$/.test(form.currency)) return setMessage({ kind: 'error', text: 'Currency must be a 3-letter ISO-4217 code.' })
    const body = { contractId: form.contractId, roomTypeId: form.roomTypeId, boardBasisId: form.boardBasisId, code: form.code.trim(), occupancy, currency: form.currency.toUpperCase(), refundable: form.refundable, taxesIncluded: form.taxesIncluded, feesIncluded: form.feesIncluded, minStay, maxStay, releaseDays }
    setSaving(true)
    try {
      if (ratePlanId) { const saved = await updateRatePlan(ratePlanId, { ...body, status: form.status }); setForm((current) => ({ ...current, status: saved.status })); setMessage({ kind: 'ok', text: 'Rate plan saved.' }) }
      else { const created = await createRatePlan(body); router.push(`/rates/plans/${created.id}`) }
    } catch (error) { setMessage({ kind: 'error', text: describeApiError(error, 'save the rate plan') }) } finally { setSaving(false) }
  }

  return (
    <div className="admin-page">
      <PageHeader eyebrow="COMMERCIAL · RATE PLANS" title={editing ? `Rate plan ${plan?.code ?? ''}` : 'New rate plan'} description="The API validates contract, room, board basis, hotel and currency relationships; this form never decides commercial validity." actions={<Link href="/rates/plans" className="admin-btn">Back to rate plans</Link>} />
      {loading ? <LoadingState rows={4} /> : loadError ? <ErrorState title="Rate plan data unavailable" description={`${loadError} No fallback data is shown.`} /> : (
        <form onSubmit={submit} className="workspace-panel" style={{ display: 'grid', gap: 4, maxWidth: 760, padding: 22 }} aria-label="Rate plan form">
          <FormField label="Contract"><select value={form.contractId} onChange={(e) => chooseContract(e.target.value)} disabled={!canManage} required><option value="">Select contract</option>{contracts.map((contract) => <option key={contract.id} value={contract.id}>{contract.code} · {contract.supplier.displayName} ({contract.status})</option>)}</select></FormField>
          <FormField label={boundHotelId ? 'Hotel (fixed by the contract’s hotel mapping)' : 'Hotel'}><select value={form.hotelId} onChange={(e) => void chooseHotel(e.target.value)} disabled={!canManage || Boolean(boundHotelId)} required><option value="">Select hotel</option>{hotels.map((hotel) => <option key={hotel.id} value={hotel.id}>{hotel.name}</option>)}</select></FormField>
          <FormField label="Room type"><select value={form.roomTypeId} onChange={(e) => set('roomTypeId', e.target.value)} disabled={!canManage || !form.hotelId} required><option value="">Select room</option>{rooms.map((room) => <option key={room.id} value={room.id}>{room.name} ({room.code}, max {room.maxOccupancy})</option>)}</select></FormField>
          <FormField label="Board basis"><select value={form.boardBasisId} onChange={(e) => set('boardBasisId', e.target.value)} disabled={!canManage} required><option value="">Select board basis</option>{boards.map((board) => <option key={board.id} value={board.id}>{board.code.trim()} · {board.name}</option>)}</select></FormField>
          <FormField label="Rate plan code"><input value={form.code} onChange={(e) => set('code', e.target.value)} disabled={!canManage} required maxLength={80} /></FormField>
          {editing ? <FormField label="Status"><select value={form.status} onChange={(e) => set('status', e.target.value)} disabled={!canManage}>{PLAN_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}</select></FormField> : null}
          <FormField label="Currency (ISO-4217)"><input value={form.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} disabled={!canManage} required maxLength={3} /></FormField>
          <FormField label="Occupancy (adults)"><input inputMode="numeric" value={form.occupancy} onChange={(e) => set('occupancy', e.target.value)} disabled={!canManage} required /></FormField>
          <FormField label="Minimum stay (nights)"><input inputMode="numeric" value={form.minStay} onChange={(e) => set('minStay', e.target.value)} disabled={!canManage} required /></FormField>
          <FormField label="Maximum stay (nights, optional)"><input inputMode="numeric" value={form.maxStay} onChange={(e) => set('maxStay', e.target.value)} disabled={!canManage} /></FormField>
          <FormField label="Release days"><input inputMode="numeric" value={form.releaseDays} onChange={(e) => set('releaseDays', e.target.value)} disabled={!canManage} required /></FormField>
          <div style={{ display: 'flex', gap: 18, fontSize: 12, margin: '6px 0 14px' }}>
            <label><input type="checkbox" checked={form.refundable} onChange={(e) => set('refundable', e.target.checked)} disabled={!canManage} /> Refundable</label>
            <label><input type="checkbox" checked={form.taxesIncluded} onChange={(e) => set('taxesIncluded', e.target.checked)} disabled={!canManage} /> Taxes included</label>
            <label><input type="checkbox" checked={form.feesIncluded} onChange={(e) => set('feesIncluded', e.target.checked)} disabled={!canManage} /> Fees included</label>
          </div>
          {message ? <p role={message.kind === 'error' ? 'alert' : 'status'} style={{ color: message.kind === 'error' ? '#bc5652' : '#1f7a5a', fontSize: 12 }}>{message.text}</p> : null}
          {canManage ? <button type="submit" className="admin-btn admin-btn-primary" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save rate plan' : 'Create rate plan'}</button> : <p role="status" style={{ fontSize: 12 }}>You have read-only access to rate plans.</p>}
          {editing && plan ? <p style={{ fontSize: 12, marginTop: 10 }}><Link href={`/rates?ratePlanId=${plan.id}`}>Open in Rates &amp; Inventory</Link> · <Link href={`/sellability?ratePlanId=${plan.id}`}>Check sellability</Link></p> : null}
        </form>
      )}
    </div>
  )
}
