import { MarketingPage } from '../../components/sections/MarketingPage'
import { marketingPages } from '../../lib/content'
import { pageMetadata } from '../../lib/seo'
export const metadata = pageMetadata({ title: 'Technology & Connectivity', description: 'fabbeds is being developed with structured data, controlled access, pricing consistency and a pathway toward scalable connectivity.', path: '/connectivity' })
export default function Page() { return <MarketingPage content={marketingPages.connectivity} /> }
