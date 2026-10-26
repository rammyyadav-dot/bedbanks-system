'use client'

import { AgentAuthGate } from '@/components/agent-auth-gate'
import { QuotationPageShell } from '@/components/quotation/quotation-page-shell'

/**
 * Starts a new quotation. Line items are added from the Search results screen ("Add to quotation"); this route
 * does not yet receive seeded items, so it opens with an empty draft until that integration is wired in.
 */
export default function NewQuotationPage() {
  return <AgentAuthGate render={(identity) => <QuotationPageShell identity={identity} />} />
}
