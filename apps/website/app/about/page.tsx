import { MarketingPage } from '../../components/sections/MarketingPage'
import { marketingPages } from '../../lib/content'
import { pageMetadata } from '../../lib/seo'
export const metadata = pageMetadata({ title: 'About fBeds', description: 'Learn how fBeds approaches B2B hotel distribution, platform architecture and controlled delivery.', path: '/about' })
export default function AboutPage() { return <MarketingPage content={marketingPages.about} /> }
