import { OperationalModule } from '../../../../../components/modules/OperationalModule'
import { moduleConfigs } from '../../../../../lib/module-data'

export default function PropertyRoomsPage() {
  return <OperationalModule config={moduleConfigs.rooms} />
}
