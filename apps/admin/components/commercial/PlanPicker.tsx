'use client'

import { useMemo } from 'react'
import type { AdminRatePlan } from '@/lib/data'

/** Cascading Hotel → Room → Rate Plan selector over already-loaded authoritative rate plans. */
export function PlanPicker({ plans, ratePlanId, onChange }: { plans: AdminRatePlan[]; ratePlanId: string; onChange: (ratePlanId: string) => void }) {
  const selected = plans.find((plan) => plan.id === ratePlanId)
  const hotelId = selected?.roomType.hotel.id ?? ''
  const roomId = selected?.roomTypeId ?? ''
  const hotels = useMemo(() => [...new Map(plans.map((plan) => [plan.roomType.hotel.id, plan.roomType.hotel.name])).entries()], [plans])
  const rooms = useMemo(() => [...new Map(plans.filter((plan) => plan.roomType.hotel.id === hotelId).map((plan) => [plan.roomTypeId, plan.roomType.name])).entries()], [plans, hotelId])
  const roomPlans = plans.filter((plan) => plan.roomTypeId === roomId)
  const firstPlan = (predicate: (plan: AdminRatePlan) => boolean) => plans.find(predicate)?.id ?? ''
  return (
    <>
      <select aria-label="Hotel" className="admin-filter-select" value={hotelId} onChange={(e) => onChange(firstPlan((plan) => plan.roomType.hotel.id === e.target.value))}><option value="">Select hotel</option>{hotels.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
      <select aria-label="Room" className="admin-filter-select" value={roomId} disabled={!hotelId} onChange={(e) => onChange(firstPlan((plan) => plan.roomTypeId === e.target.value))}><option value="">Select room</option>{rooms.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
      <select aria-label="Rate plan" className="admin-filter-select" value={ratePlanId} disabled={!roomId} onChange={(e) => onChange(e.target.value)}><option value="">Select rate plan</option>{roomPlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.code} · {plan.boardBasis.code.trim()} · {plan.currency} · {plan.status}</option>)}</select>
    </>
  )
}
