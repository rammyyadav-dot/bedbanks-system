import { OperationalModule } from '../../../../components/modules/OperationalModule'
import { moduleConfigs } from '../../../../lib/module-data'

export default function PropertyDetailPage() {
  return <OperationalModule config={{ ...moduleConfigs.rooms, eyebrow: 'Property profile', title: 'Property profile', description: 'Review content readiness, contacts, facilities and operational rules for this property.' }} />
}
