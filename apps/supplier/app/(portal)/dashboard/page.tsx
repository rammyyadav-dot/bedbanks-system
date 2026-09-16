import { DashboardView } from '../../../components/dashboard/DashboardView'
import { getSupplierAdapter } from '../../../lib/adapter'

export default async function DashboardPage() {
  const data = await getSupplierAdapter().getDashboard()
  return <DashboardView data={data} />
}
