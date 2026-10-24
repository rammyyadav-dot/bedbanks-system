'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { PageHeader } from '@/components/common/PageHeader'
import { DealForm } from '@/components/commercial/deals/DealForm'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { getDeal } from '@/lib/data/hotel-deals'
import { draftFromTerms } from '@/lib/hotel-deal-form'

export default function EditPromotionPage() {
  const { dealId } = useParams<{ dealId: string }>()
  const { state, reload } = useOpsQuery(() => getDeal(dealId), [dealId])
  return (
    <div className="admin-page">
      <PageHeader eyebrow="COMMERCIAL" title="Edit promotion" description="Only a draft can be edited. To change a submitted, approved or live promotion, return it to draft: that makes a new version that needs approving again." actions={<Link className="admin-btn" href={`/commercial/promotions/${encodeURIComponent(dealId)}`}>Back to the promotion</Link>} />
      <OpsState state={state} onRetry={reload}>
        {(deal) => deal.capabilities.canEdit
          ? <DealForm mode="edit" dealId={deal.id} hotelId={deal.hotelId} version={deal.version} initial={draftFromTerms(deal.terms)} />
          : <div className="admin-error" role="alert"><strong>This promotion cannot be edited.</strong><span>It is {deal.status.toLowerCase().replace('_', ' ')}. Return it to draft from its page to make a new version.</span></div>}
      </OpsState>
    </div>
  )
}
