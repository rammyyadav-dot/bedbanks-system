import { OperationalModule } from '../../../components/modules/OperationalModule'
import { moduleConfigs } from '../../../lib/module-data'

export default function TeamPage() {
  return <OperationalModule config={moduleConfigs.team} />
}
