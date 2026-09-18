import { OperationalModule } from '../../../../components/modules/OperationalModule'
import { moduleConfigs } from '../../../../lib/module-data'

export default function AllocationsPage() {
  return <OperationalModule config={moduleConfigs.allotments} />
}
