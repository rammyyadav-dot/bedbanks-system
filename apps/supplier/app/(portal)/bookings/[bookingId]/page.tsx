import { OperationalModule } from '../../../../components/modules/OperationalModule'
import { moduleConfigs } from '../../../../lib/module-data'

export default function BookingDetailPage() {
  return <OperationalModule config={{ ...moduleConfigs.bookings, title: 'Booking details', description: 'Review masked guest details, stay conditions and operational notes. Mutations are not enabled in this preview.' }} />
}
