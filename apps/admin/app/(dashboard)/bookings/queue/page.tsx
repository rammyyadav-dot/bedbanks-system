import { Suspense } from 'react'
import { LoadingState } from '@/components/common/LoadingState'
import { OpsQueueWorkspace } from '@/components/bookings/OpsQueueWorkspace'

export default function BookingOpsQueuePage() {
  return <Suspense fallback={<LoadingState rows={6} />}><OpsQueueWorkspace /></Suspense>
}
