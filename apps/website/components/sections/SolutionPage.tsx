import type { SolutionKey } from '../../lib/content'
import { solutionPages } from '../../lib/content'
import { MarketingPage } from './MarketingPage'

export function SolutionPage({ solution }: { solution: SolutionKey }) {
  return <MarketingPage content={solutionPages[solution]} />
}
