import { OperationalModule } from '../../../../components/modules/OperationalModule'
import { moduleConfigs } from '../../../../lib/module-data'

export default function ContractDetailPage() {
  return <OperationalModule config={moduleConfigs.contracts} />
}
