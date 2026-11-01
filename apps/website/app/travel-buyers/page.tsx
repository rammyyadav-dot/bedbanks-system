import { MarketingPage } from '../../components/sections/MarketingPage'
import { marketingPages } from '../../lib/content'
import { pageMetadata } from '../../lib/seo'
export const metadata = pageMetadata({ title: 'Travel Buyers', description: 'A structured B2B environment for travel agencies, tour operators, DMCs and wholesalers to source hotel stays with fabbeds.', path: '/travel-buyers' })
export default function Page() { return <MarketingPage content={marketingPages.travelBuyers} /> }
