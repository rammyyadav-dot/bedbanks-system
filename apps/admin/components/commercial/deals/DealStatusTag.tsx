import type { HotelDealStatus } from '@bedbanks/contracts'
import { Tag } from '@/components/ops/ops-ui'

const TONE: Record<HotelDealStatus, 'ok' | 'warn' | 'bad' | 'neutral'> = {
  DRAFT: 'neutral', PENDING_APPROVAL: 'warn', APPROVED: 'warn', REJECTED: 'bad', SCHEDULED: 'warn', ACTIVE: 'ok', PAUSED: 'warn', SUSPENDED: 'bad', EXPIRED: 'neutral', ARCHIVED: 'neutral',
}
export const STATUS_LABEL: Record<HotelDealStatus, string> = {
  DRAFT: 'Draft', PENDING_APPROVAL: 'Pending approval', APPROVED: 'Approved, not live', REJECTED: 'Rejected', SCHEDULED: 'Scheduled', ACTIVE: 'Active', PAUSED: 'Paused', SUSPENDED: 'Suspended', EXPIRED: 'Expired', ARCHIVED: 'Archived',
}

/** The word is always shown, so colour never carries the meaning alone. A deal whose stored label lags the hotel calendar shows both. */
export function DealStatusTag({ status, effective }: { status: HotelDealStatus; effective?: HotelDealStatus }) {
  const shown = effective ?? status
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
      <Tag tone={TONE[shown]}>{STATUS_LABEL[shown].toUpperCase()}</Tag>
      {effective && effective !== status ? <span style={{ fontSize: 10, color: 'var(--c-3f565c)' }} title="The stored label has not caught up with the hotel calendar yet. What applies is the status shown.">stored: {STATUS_LABEL[status]}</span> : null}
    </span>
  )
}
