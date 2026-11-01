import { MarketingPage } from '../../components/sections/MarketingPage'
import { marketingPages } from '../../lib/content'
import { pageMetadata } from '../../lib/seo'
export const metadata = pageMetadata({ title: 'Hotels & Suppliers', description: 'Bring your hotel inventory, room categories and contracted rates into a structured B2B distribution marketplace with fabbeds.', path: '/hotels-suppliers' })
export default function Page() { return <MarketingPage content={marketingPages.hotelsSuppliers} /> }
