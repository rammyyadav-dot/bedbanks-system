'use client'

import { Suspense } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { PageHeader } from '@/components/common/PageHeader'
import { LoadingState } from '@/components/common/LoadingState'
import { DealDetail } from '@/components/commercial/deals/DealDetail'

export default function PromotionPage() {
  const params = useParams<{ dealId: string }>()
  return (
    <div className="admin-page">
      <PageHeader eyebrow="COMMERCIAL" title="Promotion" description="Terms, scope, validation, approval and history of one promotion." actions={<Link className="admin-btn" href="/commercial/promotions">All promotions</Link>} />
      <Suspense fallback={<LoadingState rows={6} />}><DealDetail dealId={params.dealId} /></Suspense>
    </div>
  )
}
