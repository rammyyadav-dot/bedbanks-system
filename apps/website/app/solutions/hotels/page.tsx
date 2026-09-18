import { SolutionPage } from '../../../components/sections/SolutionPage'
import { pageMetadata } from '../../../lib/seo'
export const metadata = pageMetadata({ title: 'B2B distribution for hotels', description: 'Structure hotel content, rates and availability for controlled B2B distribution.', path: '/solutions/hotels' })
export default function Page() { return <SolutionPage solution="hotels" /> }
