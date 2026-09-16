import { HotelsView } from '../../../components/properties/PropertiesView'
import { getSupplierAdapter } from '../../../lib/adapter'

export default async function HotelsPage() {
  const hotels = await getSupplierAdapter().listProperties()
  return <HotelsView properties={hotels} />
}
