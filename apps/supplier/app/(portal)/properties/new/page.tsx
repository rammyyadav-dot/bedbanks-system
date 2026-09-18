import { OperationalModule } from '../../../../components/modules/OperationalModule'
import { moduleConfigs } from '../../../../lib/module-data'

export default function NewPropertyPage() {
  return <OperationalModule config={{ ...moduleConfigs.settings, eyebrow: 'Property setup', title: 'Add property', description: 'Start a property setup draft. Saving and publishing require the supplier API.', action: 'Save draft' }} />
}
