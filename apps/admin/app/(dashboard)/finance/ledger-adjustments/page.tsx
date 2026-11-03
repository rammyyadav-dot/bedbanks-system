import dynamic from 'next/dynamic'
import { LoadingState } from '@/components/common/LoadingState'

const LedgerAdjustments = dynamic(() => import('@/components/finance/LedgerAdjustments').then((mod) => mod.LedgerAdjustments), {
  loading: () => <LoadingState rows={8} />,
})

export default function LedgerAdjustmentsPage() {
  return <LedgerAdjustments />
}
