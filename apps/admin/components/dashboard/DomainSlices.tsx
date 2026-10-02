'use client'

import { getClientsSummary, getDistributionSummary, getServiceSummary } from '@/lib/data/departments'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Card, Stat, grid } from './FinanceAuditSlices'

/** Clients, Service and Distribution slices (ADR 0019): counts straight from each domain's summary endpoint. A missing permission shows as such, never as zero. */
export function DomainSlices() {
  const clients = useOpsQuery(() => getClientsSummary(), [])
  const service = useOpsQuery(() => getServiceSummary(), [])
  const distribution = useOpsQuery(() => getDistributionSummary(), [])
  return (
    <>
      <Card id="clients">
        <OpsState state={clients.state} onRetry={clients.reload}>
          {(c) => <ul style={grid}><Stat label="Agencies" value={c.agencies.total} href="/clients/agencies" /><Stat label="Active" value={c.agencies.active} href="/clients/agencies" /><Stat label="Members in no agency" value={c.members.notInAnyAgency} href="/clients/agencies" /></ul>}
        </OpsState>
      </Card>
      <Card id="service">
        <OpsState state={service.state} onRetry={service.reload}>
          {(s) => <ul style={grid}><Stat label="Open" value={s.byStatus.open} href="/service/cases" /><Stat label="In progress" value={s.byStatus.inProgress} href="/service/cases" /><Stat label="Unassigned" value={s.unassigned} href="/service/cases?assignee=none" /><Stat label="Urgent unresolved" value={s.urgentUnresolved} href="/service/cases" /></ul>}
        </OpsState>
      </Card>
      <Card id="distribution">
        <OpsState state={distribution.state} onRetry={distribution.reload}>
          {(d) => <ul style={grid}><Stat label="Active restrictions" value={d.active} href="/distribution/restrictions" /><Stat label="Agencies restricted" value={d.agenciesRestricted} href="/distribution/restrictions" /><Stat label="Members affected" value={d.membersAffected} href="/distribution/restrictions" /></ul>}
        </OpsState>
      </Card>
    </>
  )
}
