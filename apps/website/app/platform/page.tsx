import { MarketingPage } from '../../components/sections/MarketingPage'
import { marketingPages } from '../../lib/content'
import { pageMetadata } from '../../lib/seo'
export const metadata = pageMetadata({ title: 'Hotel distribution platform', description: 'Explore fBeds workflows for supply operations, buyer journeys and platform oversight.', path: '/platform' })
export default function PlatformPage() { return <MarketingPage content={marketingPages.platform} /> }
