import { SolutionPage } from '../../../components/sections/SolutionPage'
import { pageMetadata } from '../../../lib/seo'
export const metadata = pageMetadata({ title: 'Hotel distribution for tour operators', description: 'Organise contracted rates, allotments and restrictions for tour-operator workflows.', path: '/solutions/tour-operators' })
export default function Page() { return <SolutionPage solution="tour-operators" /> }
