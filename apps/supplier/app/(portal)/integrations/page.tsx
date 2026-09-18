import { OperationalModule } from '../../../components/modules/OperationalModule'
import { moduleConfigs } from '../../../lib/module-data'

export default function IntegrationsPage() {
  return <OperationalModule config={moduleConfigs.connectivity} />
}
