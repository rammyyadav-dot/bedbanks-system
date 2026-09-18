import { HotelsView } from '../../../components/properties/PropertiesView'
import { getSupplierAdapter } from '../../../lib/adapter'

export default async function PropertiesPage() {
  const properties = await getSupplierAdapter().listProperties()
  return <HotelsView properties={properties} />
}
