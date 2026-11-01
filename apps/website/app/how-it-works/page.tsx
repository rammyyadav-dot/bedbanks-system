import { MarketingPage } from '../../components/sections/MarketingPage'
import { marketingPages } from '../../lib/content'
import { pageMetadata } from '../../lib/seo'
export const metadata = pageMetadata({ title: 'How It Works', description: 'How fabbeds connects contracted hotel supply, distribution rules and approved travel buyers, plus answers to common questions.', path: '/how-it-works' })
export default function Page() { return <MarketingPage content={marketingPages.howItWorks} /> }
