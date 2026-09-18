import { OperationalModule } from '../../../../components/modules/OperationalModule'
import { moduleConfigs } from '../../../../lib/module-data'

export default function NewContractPage() {
  return <OperationalModule config={{ ...moduleConfigs.contracts, title: 'Create contract draft', description: 'Build a contract wizard draft. API integration is required to save, approve or publish terms.' }} />
}
