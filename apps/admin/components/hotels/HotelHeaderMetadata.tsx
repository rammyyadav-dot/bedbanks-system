'use client'

import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { when } from '@/components/ops/ops-ui'
import { hotelLifecycleLabel } from '@/lib/hotel-ui'
import { getHotelSetup } from '@/lib/data/hotel-setup'

export function HotelHeaderMetadata({ hotelId, updatedAt, contentStatus }: { hotelId: string; updatedAt: string; contentStatus: string }) {
  const { state } = useOpsQuery(() => getHotelSetup(hotelId), [hotelId, updatedAt])
  const status = state.status === 'ready' && state.data.publication && ['PENDING', 'APPROVED'].includes(state.data.publication.status) ? 'Under Review' : hotelLifecycleLabel(contentStatus)
  return <>
    <div><dt>Profile lifecycle</dt><dd>{status}</dd></div>
    <div><dt>Last updated</dt><dd>{when(state.status === 'ready' ? state.data.governance.updatedAt : updatedAt)}</dd></div>
    <div><dt>Updated by</dt><dd>{state.status === 'ready' ? state.data.governance.updatedById ?? 'Not recorded' : state.status === 'loading' ? 'Loading…' : 'Unavailable'}</dd></div>
  </>
}
