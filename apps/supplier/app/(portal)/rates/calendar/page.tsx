import { OperationalModule } from '../../../../components/modules/OperationalModule'
import { moduleConfigs } from '../../../../lib/module-data'

export default function RatesCalendarPage() {
  return <OperationalModule config={{ ...moduleConfigs.rates, title: 'Rate calendar', description: 'Review typed rate drafts by date, room and meal plan. Publishing is unavailable until API integration is connected.' }} />
}
