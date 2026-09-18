import { OperationalModule } from '../../../../components/modules/OperationalModule'
import { moduleConfigs } from '../../../../lib/module-data'

export default function StopSalesPage() {
  return <OperationalModule config={moduleConfigs.restrictions} />
}
