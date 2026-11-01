import { ContractForm } from '@/components/commercial/ContractForm'

export default async function ContractPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <ContractForm contractId={id} />
}
