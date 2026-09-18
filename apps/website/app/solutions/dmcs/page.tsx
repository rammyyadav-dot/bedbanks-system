import { SolutionPage } from '../../../components/sections/SolutionPage'
import { pageMetadata } from '../../../lib/seo'
export const metadata = pageMetadata({ title: 'Hotel distribution for DMCs', description: 'Prepare local hotel portfolios for commercial control and B2B distribution.', path: '/solutions/dmcs' })
export default function Page() { return <SolutionPage solution="dmcs" /> }
