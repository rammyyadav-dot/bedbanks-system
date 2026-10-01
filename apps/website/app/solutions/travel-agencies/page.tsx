import { SolutionPage } from '../../../components/sections/SolutionPage'
import { pageMetadata } from '../../../lib/seo'
export const metadata = pageMetadata({ title: 'Hotel distribution for travel agencies', description: 'Planned agency workflows for searching, reviewing and operating B2B hotel bookings.', path: '/solutions/travel-agencies' })
export default function Page() { return <SolutionPage solution="travel-agencies" /> }
