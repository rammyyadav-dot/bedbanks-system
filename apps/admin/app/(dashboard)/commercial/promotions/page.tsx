'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { PageHeader } from '@/components/common/PageHeader'
import { Tabs } from '@/components/common/Tabs'
import { LoadingState } from '@/components/common/LoadingState'
import { DealApprovalQueue } from '@/components/commercial/deals/DealApprovalQueue'
import { DealsOverview } from '@/components/commercial/deals/DealsOverview'

function Promotions() {
  const hotelId = useSearchParams().get('hotelId') ?? undefined
  return (
    <div className="admin-page">
      <PageHeader eyebrow="COMMERCIAL" title="Deals and promotions" description="Create promotions for a hotel's rate plans. A promotion sells only after it is validated, submitted, approved by a different person and activated. Prices, guards and dates are applied by the API, in the hotel's calendar." />
      <Tabs defaultTab="promotions" tabs={[
        { id: 'promotions', label: 'Promotions', content: <DealsOverview hotelId={hotelId} newHref={hotelId ? `/commercial/promotions/new?hotelId=${encodeURIComponent(hotelId)}` : '/commercial/promotions/new'} /> },
        { id: 'queue', label: 'Approval queue', content: <DealApprovalQueue /> },
      ]} />
    </div>
  )
}

export default function PromotionsPage() { return <Suspense fallback={<LoadingState rows={6} />}><Promotions /></Suspense> }
