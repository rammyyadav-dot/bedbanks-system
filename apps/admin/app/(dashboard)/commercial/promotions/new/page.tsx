'use client'

import { Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { PageHeader } from '@/components/common/PageHeader'
import { LoadingState } from '@/components/common/LoadingState'
import { DealForm } from '@/components/commercial/deals/DealForm'
import { useCan } from '@/lib/auth/capabilities'

function NewPromotion() {
  const hotelId = useSearchParams().get('hotelId') ?? undefined
  const canManage = useCan()('supply.rates.manage')
  return (
    <div className="admin-page">
      <PageHeader eyebrow="COMMERCIAL" title="Create new promotion" description="Set up a promotional offer for a hotel. It is saved as a draft and sells nothing until it is approved and activated." actions={<Link className="admin-btn" href={hotelId ? `/commercial/promotions?hotelId=${encodeURIComponent(hotelId)}` : '/commercial/promotions'}>Back to promotions</Link>} />
      {canManage ? <DealForm mode="create" hotelId={hotelId} /> : <div className="admin-error" role="alert"><strong>You cannot create promotions.</strong><span>Creating a promotion needs rate management permission.</span></div>}
    </div>
  )
}

export default function NewPromotionPage() { return <Suspense fallback={<LoadingState rows={6} />}><NewPromotion /></Suspense> }
