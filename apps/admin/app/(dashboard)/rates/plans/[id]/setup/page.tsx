import { RatePlanWizard } from '@/components/commercial/RatePlanWizard'

export default async function RatePlanSetupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <RatePlanWizard ratePlanId={id} />
}
