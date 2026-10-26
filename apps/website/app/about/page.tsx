import { MarketingPage } from '../../components/sections/MarketingPage'
import { marketingPages } from '../../lib/content'
import { pageMetadata } from '../../lib/seo'
export const metadata = pageMetadata({ title: 'About fabbeds', description: 'fabbeds is building a B2B hotel distribution marketplace that brings accommodation suppliers and professional travel businesses closer together.', path: '/about' })
export default function Page() { return <MarketingPage content={marketingPages.about} /> }
