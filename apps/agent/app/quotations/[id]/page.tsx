'use client'

import { useParams } from 'next/navigation'
import { AgentAuthGate } from '@/components/agent-auth-gate'
import { QuotationPageShell } from '@/components/quotation/quotation-page-shell'

export default function EditQuotationPage() {
  const params = useParams<{ id: string }>()
  return <AgentAuthGate render={(identity) => <QuotationPageShell identity={identity} quotationId={params.id} />} />
}
