import { RatesWorkbench } from '@/components/commercial/RatesWorkbench'

export default async function RatesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { ratePlanId } = await searchParams
  return <RatesWorkbench initialRatePlanId={typeof ratePlanId === 'string' ? ratePlanId : ''} />
}
