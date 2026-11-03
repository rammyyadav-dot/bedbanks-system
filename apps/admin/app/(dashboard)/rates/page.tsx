import dynamic from 'next/dynamic'
import { LoadingState } from '@/components/common/LoadingState'

const RatesWorkbench = dynamic(() => import('@/components/commercial/RatesWorkbench').then((mod) => mod.RatesWorkbench), {
  loading: () => <LoadingState rows={8} />,
})

export default async function RatesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { ratePlanId } = await searchParams
  return <RatesWorkbench initialRatePlanId={typeof ratePlanId === 'string' ? ratePlanId : ''} />
}
