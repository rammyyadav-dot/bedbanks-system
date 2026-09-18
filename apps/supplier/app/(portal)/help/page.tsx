import { OperationalModule } from '../../../components/modules/OperationalModule'
import { moduleConfigs } from '../../../lib/module-data'

export default function HelpPage() {
  return <OperationalModule config={moduleConfigs.support} />
}
