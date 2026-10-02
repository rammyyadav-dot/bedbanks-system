'use client'

import Link from 'next/link'
import { OpsListPage } from '@/components/ops/OpsListPage'
import { Tag } from '@/components/ops/ops-ui'
import { getOpsHotels } from '@/lib/data/operations'
import type { HotelOperationsRow } from '@bedbanks/contracts'

export default function HotelReadinessPage() {
  return (
    <OpsListPage<HotelOperationsRow>
      eyebrow="DUBAI OPERATIONS" title="Hotel readiness" description="Per-hotel sellability computed by the canonical API evaluator over the next 30 nights. Blockers are the most frequent reason codes."
      filters={[
        { key: 'search', label: 'Name starts with', type: 'text' },
        { key: 'readiness', label: 'Readiness', type: 'select', options: ['READY', 'BLOCKED', 'NOT_CONFIGURED'].map(v => ({ value: v, label: v })) },
        { key: 'mapping', label: 'Supplier mapping', type: 'select', options: ['MAPPED', 'PENDING', 'REJECTED', 'NONE'].map(v => ({ value: v, label: v })) },
        { key: 'contentStatus', label: 'Content', type: 'select', options: ['DRAFT', 'INCOMPLETE', 'COMPLETE', 'SUSPENDED'].map(v => ({ value: v, label: v })) },
      ]}
      load={getOpsHotels} getRowId={h => h.id}
      emptyTitle="No hotels match" emptyDescription="The query succeeded and no hotel matches these filters."
      columns={[
        { key: 'name', header: 'Hotel', render: h => <Link href={`/hotels/${h.id}`} style={{ fontWeight: 600 }}>{h.name}</Link> },
        { key: 'content', header: 'Content', render: h => h.contentStatus },
        { key: 'rooms', header: 'Rooms', align: 'right', render: h => h.rooms },
        { key: 'plans', header: 'Rate plans', align: 'right', render: h => h.ratePlans },
        { key: 'map', header: 'Mappings (mapped/pending/rejected)', render: h => `${h.mappings.mapped}/${h.mappings.pending}/${h.mappings.rejected}` },
        { key: 'ready', header: 'Readiness', render: h => <Tag tone={h.readiness === 'READY' ? 'ok' : h.readiness === 'BLOCKED' ? 'bad' : 'neutral'}>{h.readiness ?? '—'}</Tag> },
        { key: 'blockers', header: 'Top blockers', render: h => (h.blockers?.length ? h.blockers.join(', ') : '—') },
      ]}
    />
  )
}
