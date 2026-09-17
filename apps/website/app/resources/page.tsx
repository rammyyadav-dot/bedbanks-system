import { MarketingPage } from '../../components/sections/MarketingPage'
import { marketingPages } from '../../lib/content'
import { pageMetadata } from '../../lib/seo'
export const metadata = pageMetadata({ title: 'Hotel distribution resources', description: 'Practical frameworks for hotel content, inventory, operations and travel-technology integration.', path: '/resources' })
export default function ResourcesPage() { return <MarketingPage content={marketingPages.resources} /> }
