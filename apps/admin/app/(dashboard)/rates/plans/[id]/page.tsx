import { RatePlanForm } from '@/components/commercial/RatePlanForm'

export default async function RatePlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <RatePlanForm ratePlanId={id} />
}
