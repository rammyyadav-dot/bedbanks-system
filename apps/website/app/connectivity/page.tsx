import { MarketingPage } from '../../components/sections/MarketingPage'
import { marketingPages } from '../../lib/content'
import { pageMetadata } from '../../lib/seo'
export const metadata = pageMetadata({ title: 'Hotel distribution connectivity', description: 'See how fBeds approaches supplier adapters, buyer APIs and observable integration boundaries.', path: '/connectivity' })
export default function ConnectivityPage() { return <MarketingPage content={marketingPages.connectivity} /> }
