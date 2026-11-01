import { PublicPage } from '@/components/entrance/trade-frame'
import { editorialPages } from '@/lib/marketplace-content'

export default function AboutPage() {
  const page = editorialPages.about
  return <PublicPage kicker={page.kicker} title={page.title} summary={page.summary} sections={page.sections} />
}
