import { MarketingPage } from '../../components/sections/MarketingPage'
import { marketingPages } from '../../lib/content'
import { pageMetadata } from '../../lib/seo'
export const metadata = pageMetadata({ title: 'Hotel inventory management', description: 'Organise contracted hotel supply with explicit rates, restrictions and readiness checks. Connected supply is coming soon.', path: '/inventory' })
export default function InventoryPage() { return <MarketingPage content={marketingPages.inventory} /> }
