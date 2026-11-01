import { redirect } from 'next/navigation'
import { SupplierShell } from '../../components/layout/SupplierShell'
import { SupplyWorkflowUnavailable } from '../../components/supply/SupplyWorkflowUnavailable'
import { loadPortal } from '../../lib/portal'

export const dynamic = 'force-dynamic'

export default async function PortalLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const portal = await loadPortal()
  if (portal.kind === 'anonymous') redirect('/login')
  const userLabel = portal.user.name || portal.user.email || 'Signed out'
  const organizations = portal.kind === 'choose-organization' || portal.kind === 'ready' ? portal.organizations : []
  const active = portal.kind === 'ready' ? portal.organization : null

  let body = children
  if (portal.kind === 'unavailable') {
    body = <SupplyWorkflowUnavailable eyebrow="Workspace" title="Supplier workspace unavailable" description={portal.message} />
  } else if (portal.kind === 'ambiguous-tenant') {
    body = <SupplyWorkflowUnavailable eyebrow="Workspace" title="Tenant membership is ambiguous" description="This account belongs to more than one tenant. The extranet does not choose a tenant from the browser." />
  } else if (portal.kind === 'choose-organization') {
    body = <SupplyWorkflowUnavailable eyebrow="Workspace" title="Choose a supplier organization" description="Select an organization in the sidebar. The server checks that membership before any hotel is loaded." />
  }

  return (
    <SupplierShell userLabel={userLabel} userDetail="Supplier membership" organizations={organizations} active={active}>
      {body}
    </SupplierShell>
  )
}
