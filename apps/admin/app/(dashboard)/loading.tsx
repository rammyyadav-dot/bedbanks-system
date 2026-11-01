import { LoadingState } from '@/components/common/LoadingState'

/** Instant skeleton while a dashboard route streams in, so navigation never shows a blank main area. */
export default function DashboardLoading() {
  return <div className="admin-page"><LoadingState rows={8} /></div>
}
